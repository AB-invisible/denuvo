"""
Headless EA email/password login for remid + trust cookies.

Uses the signin.ea.com web flow (same pattern as public EA login helpers).
First login on a fresh account may require email verification — trust cookies
stored in ea_session.json skip that on later runs.

Railway/datacenter IPs often hit FunCaptcha on password login. When that happens
we fall back to EA's email one-time-code path (/eacode on the bot).
"""

from __future__ import annotations

import re
import time
from typing import Optional
from urllib.parse import urljoin

import requests

from ea_pc_sign import generate_pc_sign, random_cid
from ea_session import EaSession, save_session
from ea_pending import clear_pending, load_pending, masked_email, save_pending

AUTH_URL = "https://accounts.ea.com/connect/auth"
CLIENT_ID = "JUNO_PC_CLIENT"
REDIRECT_URI = "qrc:///html/login_successful.html"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

WINDOW_LOCATION_RE = re.compile(r'window\.location\s*=\s*"([^"]+)"', re.I)
EMAIL_CODE_RADIO_RE = re.compile(
    r'<input[^>]+type="radio"[^>]+name="_codeType"[^>]+value="EMAIL"[^>]+id="([^"]+)"',
    re.I,
)
READ_ACCEPT_RE = re.compile(r'<input[^>]+id="readAccept"[^>]+name="readAccept"', re.I)
INVALID_CREDS_RE = re.compile(
    r"(?i)(credentials you entered are incorrect|email or password is incorrect|incorrect or have expired)",
)
CAPTCHA_RE = re.compile(r"(?i)(captcha|recaptcha|hcaptcha|arkose|funcaptcha|fc-token)")
SEND_CODE_RE = re.compile(
    r'(?i)(id="btnSendCode"|dynamicchallenge/sendCode|name="codeType"[^>]*value="EMAIL")',
)
VERIFY_CODE_RE = re.compile(r'(?i)(name="oneTimeCode"|dynamicchallenge/verifyCode|id="twoFactorCode")')
INVALID_CODE_RE = re.compile(r"(?i)(security code you entered is invalid|code you entered is (?:invalid|incorrect))")
ONE_TIME_HINT_RE = re.compile(
    r"(?i)(one[\s\-‑–—]?time\s*code|get\s*one[\s\-]?time|loginwithotp|loginWithOTP|btnSendCode|sign in with a one-time code)",
)
GET_ONE_TIME_LINK_RE = re.compile(
    r'(?i)(?:href|data-href)\s*=\s*["\']([^"\']+)["\'][^>]{0,120}?(?:get\s*one[\s\-]?time|one[\s\-]?time\s*code)',
)
GET_ONE_TIME_ID_RE = re.compile(
    r'(?i)id\s*=\s*["\']([^"\']*(?:otp|one.?time|sendcode)[^"\']*)["\']',
)


class EaLoginError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _browser_session() -> requests.Session:
    http = requests.Session()
    http.headers.update(
        {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
        }
    )
    return http


def _diag(stage: str, resp: "requests.Response") -> None:
    try:
        raw = resp.text or ""
        stripped = re.sub(r"(?is)<script.*?</script>|<style.*?</style>", " ", raw)
        text = re.sub(r"<[^>]+>", " ", stripped)
        text = re.sub(r"\s+", " ", text).strip()
        markers = []
        if INVALID_CREDS_RE.search(raw):
            markers.append("INVALID_CREDS")
        if CAPTCHA_RE.search(raw):
            markers.append("CAPTCHA")
        if SEND_CODE_RE.search(raw):
            markers.append("SEND_CODE")
        if VERIFY_CODE_RE.search(raw):
            markers.append("VERIFY_CODE")
        if ONE_TIME_HINT_RE.search(raw):
            markers.append("ONE_TIME")
        m = re.search(
            r"(?i)(incorrect|expired|verify|captcha|human|arkose|robot|too many|locked|disabled|unusual|suspicious)",
            text,
        )
        region = text[max(0, m.start() - 140): m.start() + 320] if m else text[:460]
        print(
            f"[ea_login] {stage}: status={resp.status_code} url={resp.url} "
            f"markers={markers or ['none']} text={region!r}",
            flush=True,
        )
    except Exception:
        pass


def _extract_hidden_fields(html: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for tag in re.findall(r"(?is)<input[^>]+>", html or ""):
        if not re.search(r'type\s*=\s*["\']hidden["\']', tag, re.I):
            continue
        name_m = re.search(r'name\s*=\s*["\']([^"\']+)["\']', tag, re.I)
        if not name_m:
            continue
        val_m = re.search(r'value\s*=\s*["\']([^"\']*)["\']', tag, re.I)
        fields[name_m.group(1)] = val_m.group(1) if val_m else ""
    return fields


def _juno_auth_start_url(pc_sign: str) -> str:
    params = {
        "client_id": CLIENT_ID,
        "response_type": "code id_token",
        "redirect_uri": REDIRECT_URI,
        "display": "junoClient/login",
        "locale": "en_US",
        "pc_sign": pc_sign,
        "sbiod_enabled": "true",
    }
    return requests.Request("GET", AUTH_URL, params=params).prepare().url or AUTH_URL


def _extract_redirect(html: str) -> str:
    compact = html.replace(" ", "")
    m = WINDOW_LOCATION_RE.search(compact)
    if not m:
        raise EaLoginError("LoginFailed", "EA sign-in did not return a redirect URL")
    return m.group(1).replace("\\/", "/")


def _cookie_dict(resp: requests.Response) -> dict[str, str]:
    out: dict[str, str] = {}
    for c in resp.cookies:
        out[c.name] = c.value
    return out


def _apply_trust_cookies(sess: requests.Session, trust: dict[str, str]) -> None:
    for name, value in trust.items():
        if value:
            sess.cookies.set(name, value, domain=".ea.com")
            sess.cookies.set(name, value, domain="signin.ea.com")


def _save_pending_code_flow(
    http: requests.Session,
    email: str,
    seed: str,
    pc_sign: str,
    base: EaSession,
    verify_url: str,
) -> None:
    save_pending(
        {
            "email": email.strip(),
            "seed": seed,
            "pc_sign": pc_sign,
            "machine_hash": base.machine_hash or "",
            "verify_url": verify_url,
            "cookies": requests.utils.dict_from_cookiejar(http.cookies),
        }
    )
    raise EaLoginError(
        "EmailCodePending",
        f"EA emailed a verification code to {masked_email(email)} — submit it with /eacode <code>.",
    )


def _send_email_code_and_pending(
    http: requests.Session,
    page_url: str,
    page_html: str,
    email: str,
    seed: str,
    pc_sign: str,
    base: EaSession,
    timeout: int,
) -> EaSession:
    hidden = _extract_hidden_fields(page_html)
    r_send = http.post(
        page_url,
        data={**hidden, "codeType": "EMAIL", "_eventId": "submit"},
        timeout=timeout,
        allow_redirects=True,
    )
    verify_body = r_send.text or ""
    _diag("send-email-code", r_send)
    if not VERIFY_CODE_RE.search(verify_body):
        raise EaLoginError("LoginFailed", "EA did not return the code-entry page after requesting a code")
    _save_pending_code_flow(http, email, seed, pc_sign, base, r_send.url)
    return base  # unreachable


def _otp_flow_needed(body: str) -> bool:
    """EA often shows fake 'wrong password' when captcha/bot checks fail on datacenter IPs."""
    return bool(
        CAPTCHA_RE.search(body)
        or ONE_TIME_HINT_RE.search(body)
        or SEND_CODE_RE.search(body)
        or EMAIL_CODE_RADIO_RE.search(body)
    )


def _otp_payloads(hidden: dict[str, str], email: str) -> list[dict[str, str]]:
    """Spring Web Flow event payloads seen on signin.ea.com for email OTP."""
    base = {**hidden, "email": email.strip()}
    return [
        {**base, "_eventId": "submit", "loginMethod": "emailOtp"},
        {**base, "_eventId": "oneTimeCode"},
        {**base, "_eventId": "submit", "loginMethod": "oneTimeCode"},
        {**base, "_eventId": "submit", "codeType": "EMAIL"},
        {**base, "_eventId": "sendCode", "codeType": "EMAIL"},
        {**base, "_eventId": "loginWithOTP"},
        {**base, "_eventId": "submit", "loginMethod": "OTP"},
        {**base, "_eventId": "submit", "rememberMe": "on", "_rememberMe": "on", "loginMethod": "emailOtp"},
    ]


def _run_otp_attempts(
    http: requests.Session,
    page_url: str,
    page_html: str,
    email: str,
    seed: str,
    pc_sign: str,
    base: EaSession,
    timeout: int,
    stage_prefix: str = "otp",
) -> EaSession:
    hidden = _extract_hidden_fields(page_html)
    for idx, payload in enumerate(_otp_payloads(hidden, email)):
        http.headers["Referer"] = page_url
        http.headers["Origin"] = "https://signin.ea.com"
        http.headers["Sec-Fetch-Site"] = "same-origin"
        r = http.post(page_url, data=payload, timeout=timeout, allow_redirects=True)
        body = r.text or ""
        _diag(f"{stage_prefix}-attempt-{idx}", r)

        if VERIFY_CODE_RE.search(body):
            _save_pending_code_flow(http, email, seed, pc_sign, base, r.url)
        if EMAIL_CODE_RADIO_RE.search(body) or SEND_CODE_RE.search(body):
            return _send_email_code_and_pending(http, r.url, body, email, seed, pc_sign, base, timeout)
        if WINDOW_LOCATION_RE.search(body.replace(" ", "")):
            return _finish_login(http, body, r.url, email, pc_sign, base, seed, timeout)

    raise EaLoginError(
        "EmailCodePending",
        f"EA blocked automated password login. Check **{masked_email(email)}** for a one-time code, "
        f"then run `/eacode <code>`. If nothing arrived, run `/ealogin` again to resend.",
    )


def _handle_login_response(
    http: requests.Session,
    body: str,
    page_url: str,
    email: str,
    password: str,
    seed: str,
    pc_sign: str,
    base: EaSession,
    timeout: int,
) -> EaSession:
    has_captcha = bool(CAPTCHA_RE.search(body))
    has_invalid = bool(INVALID_CREDS_RE.search(body))
    needs_otp = _otp_flow_needed(body)

    if EMAIL_CODE_RADIO_RE.search(body) or SEND_CODE_RE.search(body):
        return _send_email_code_and_pending(http, page_url, body, email, seed, pc_sign, base, timeout)

    if VERIFY_CODE_RE.search(body):
        _save_pending_code_flow(http, email, seed, pc_sign, base, page_url)

    # Captcha / bot checks show a fake "incorrect credentials" banner — never treat as wrong password.
    if has_captcha or (has_invalid and needs_otp):
        return _run_otp_attempts(http, page_url, body, email, seed, pc_sign, base, timeout, "otp-after-password")

    if has_invalid:
        raise EaLoginError(
            "AuthError",
            "EA rejected the email or password — verify credentials in a browser at signin.ea.com",
        )

    return _finish_login(http, body, page_url, email, pc_sign, base, seed, timeout)


def _open_signin_page(
    email: str,
    seed: str,
    existing: Optional[EaSession] = None,
    timeout: int = 45,
) -> tuple[requests.Session, str, str, str, EaSession]:
    """GET the juno sign-in page and return (http, html, post_url, pc_sign, base session)."""
    pc_sign = generate_pc_sign(seed)
    http = _browser_session()
    base = existing or EaSession()
    if base.trust_cookies:
        _apply_trust_cookies(http, base.trust_cookies)

    start = _juno_auth_start_url(pc_sign)
    r1 = http.get(start, timeout=timeout, allow_redirects=True)
    if "signin.ea.com" not in r1.url:
        raise EaLoginError("LoginFailed", f"expected signin.ea.com, got {r1.url[:120]}")
    return http, r1.text or "", r1.url, pc_sign, base


def login_with_one_time_code(
    email: str,
    password: str,
    seed: str,
    existing: Optional[EaSession] = None,
    timeout: int = 45,
) -> EaSession:
    """
    Request EA email one-time code without posting the password.
    Datacenter IPs (Railway) hit FunCaptcha on password login — this path works around it.
    """
    if not email:
        raise EaLoginError("AuthError", "email is required")

    http, login_html, post_url, pc_sign, base = _open_signin_page(email, seed, existing, timeout)

    if ONE_TIME_HINT_RE.search(login_html) or SEND_CODE_RE.search(login_html):
        return _run_otp_attempts(http, post_url, login_html, email, seed, pc_sign, base, timeout, "otp-first")

    # Some flows need email submitted before the OTP option appears.
    hidden = _extract_hidden_fields(login_html)
    http.headers["Referer"] = post_url
    http.headers["Origin"] = "https://signin.ea.com"
    r_email = http.post(
        post_url,
        data={**hidden, "email": email.strip(), "regionCode": "US", "_eventId": "submit", "loginMethod": "emailOtp"},
        timeout=timeout,
        allow_redirects=True,
    )
    body = r_email.text or ""
    _diag("otp-email-only", r_email)
    return _run_otp_attempts(http, r_email.url, body, email, seed, pc_sign, base, timeout, "otp-after-email")


def login_with_email_password(
    email: str,
    password: str,
    seed: str,
    existing: Optional[EaSession] = None,
    timeout: int = 45,
) -> EaSession:
    if not email or not password:
        raise EaLoginError("AuthError", "email and password are required")

    http, login_html, post_url, pc_sign, base = _open_signin_page(email, seed, existing, timeout)
    hidden = _extract_hidden_fields(login_html)

    data = {
        **hidden,
        "email": email,
        "regionCode": "US",
        "phoneNumber": "",
        "password": password,
        "_eventId": "submit",
        "cid": random_cid(),
        "showAgeUp": "true",
        "thirdPartyCaptchaResponse": "",
        "loginMethod": "emailPassword",
        "_rememberMe": "on",
        "rememberMe": "on",
    }

    http.headers["Referer"] = post_url
    http.headers["Origin"] = "https://signin.ea.com"
    http.headers["Sec-Fetch-Site"] = "same-origin"
    http.headers["Content-Type"] = "application/x-www-form-urlencoded"

    r2 = http.post(post_url, data=data, timeout=timeout, allow_redirects=True)
    body = r2.text or ""
    _diag("password-post", r2)

    return _handle_login_response(http, body, r2.url, email, password, seed, pc_sign, base, timeout)


def _finish_login(
    http: requests.Session,
    body: str,
    post_url: str,
    email: str,
    pc_sign: str,
    base: EaSession,
    seed: str,
    timeout: int = 45,
) -> EaSession:
    if READ_ACCEPT_RE.search(body):
        hidden = _extract_hidden_fields(body)
        r3 = http.post(
            post_url,
            data={**hidden, "_readAccept": "on", "readAccept": "on", "_eventId": "accept"},
            timeout=timeout,
            allow_redirects=True,
        )
        body = r3.text or ""
        post_url = r3.url

    redirect_url = _extract_redirect(body)
    if redirect_url.startswith("/"):
        redirect_url = urljoin(post_url, redirect_url)

    r4 = http.get(redirect_url, timeout=timeout, allow_redirects=False)
    cookies = _cookie_dict(r4)
    remid = cookies.get("remid") or http.cookies.get("remid")

    loc = r4.headers.get("Location", "")
    if loc:
        r5 = http.get(loc, timeout=timeout, allow_redirects=True)
        cookies.update(_cookie_dict(r5))
        remid = remid or cookies.get("remid") or http.cookies.get("remid")

    if not remid:
        raise EaLoginError("LoginFailed", "login succeeded but remid cookie was missing")

    trust = {k: v for k, v in cookies.items() if k in ("osc", "_nx_mpcid", "remid", "sid")}
    for c in http.cookies:
        if c.name in ("osc", "_nx_mpcid", "sid") and c.name not in trust:
            trust[c.name] = c.value

    from ea_pc_sign import generate_machine_hash

    out = EaSession(
        email=email.strip(),
        remid=str(remid),
        login_signature=pc_sign,
        login_sv="v2",
        machine_hash=base.machine_hash or generate_machine_hash(seed),
        trust_cookies=trust,
        updated_at=time.time(),
    )
    save_session(out)
    return out


def submit_verification_code(code: str, timeout: int = 45) -> EaSession:
    pending = load_pending()
    if not pending:
        raise EaLoginError("NoPendingVerification", "No EA verification is waiting — trigger a login first, then use /eacode.")

    digits = re.sub(r"\D", "", str(code or ""))
    if len(digits) < 4:
        raise EaLoginError("InvalidRequest", "Enter the numeric code EA emailed you.")

    http = _browser_session()
    http.cookies = requests.utils.cookiejar_from_dict(pending.get("cookies") or {})

    r = http.post(
        pending["verify_url"],
        data={
            "oneTimeCode": digits,
            "trustThisDevice": "on",
            "_trustThisDevice": "on",
            "_eventId": "submit",
        },
        timeout=timeout,
        allow_redirects=True,
    )
    body = r.text or ""
    if INVALID_CODE_RE.search(body):
        raise EaLoginError("InvalidCode", "EA rejected that code — check it and run /eacode again, or request a new one.")

    base = EaSession(machine_hash=pending.get("machine_hash", "") or "")
    out = _finish_login(
        http,
        body,
        r.url,
        pending.get("email", ""),
        pending.get("pc_sign", ""),
        base,
        pending.get("seed", ""),
        timeout,
    )
    clear_pending()
    return out
