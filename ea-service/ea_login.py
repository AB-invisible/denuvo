"""
Headless EA email/password login for remid + trust cookies.

Uses the signin.ea.com web flow (same pattern as public EA login helpers).
First login on a fresh account may require email verification — trust cookies
stored in ea_session.json skip that on later runs.
"""

from __future__ import annotations

import re
import time
from typing import Optional
from urllib.parse import urljoin, urlparse

import requests

from ea_pc_sign import generate_pc_sign, random_cid
from ea_session import EaSession, save_session
from ea_pending import clear_pending, load_pending, masked_email, save_pending

AUTH_URL = "https://accounts.ea.com/connect/auth"
CLIENT_ID = "JUNO_PC_CLIENT"
REDIRECT_URI = "qrc:///html/login_successful.html"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
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
CAPTCHA_RE = re.compile(r"(?i)(captcha|recaptcha|hcaptcha|arkose|funcaptcha)")
# "Verify your identity / Send Code" page (dynamicchallenge/sendCode). Current EA
# uses a hidden name="codeType" value="EMAIL" + a Send Code button — not the old
# _codeType radios — so match either.
SEND_CODE_RE = re.compile(
    r'(?i)(id="btnSendCode"|dynamicchallenge/sendCode|name="codeType"[^>]*value="EMAIL")',
)
# "Enter your code" page (dynamicchallenge/verifyCode) with the oneTimeCode box.
VERIFY_CODE_RE = re.compile(r'(?i)(name="oneTimeCode"|dynamicchallenge/verifyCode|id="twoFactorCode")')
INVALID_CODE_RE = re.compile(r"(?i)(security code you entered is invalid|code you entered is (?:invalid|incorrect))")


class EaLoginError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _diag(stage: str, resp: "requests.Response") -> None:
    """Print a password-free snippet of EA's response so headless-login failures
    are debuggable from Railway logs (invalid-creds vs captcha vs challenge)."""
    try:
        text = re.sub(r"<[^>]+>", " ", resp.text or "")
        text = re.sub(r"\s+", " ", text).strip()
        markers = []
        if INVALID_CREDS_RE.search(resp.text or ""):
            markers.append("INVALID_CREDS")
        if CAPTCHA_RE.search(resp.text or ""):
            markers.append("CAPTCHA")
        if SEND_CODE_RE.search(resp.text or ""):
            markers.append("SEND_CODE")
        if VERIFY_CODE_RE.search(resp.text or ""):
            markers.append("VERIFY_CODE")
        print(
            f"[ea_login] {stage}: status={resp.status_code} url={resp.url} "
            f"markers={markers or ['none']} snippet={text[:400]!r}",
            flush=True,
        )
    except Exception:
        pass


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


def login_with_email_password(
    email: str,
    password: str,
    seed: str,
    existing: Optional[EaSession] = None,
    timeout: int = 45,
) -> EaSession:
    """
    Perform signin.ea.com login and return a populated EaSession.
    Raises EaLoginError on failure / email verification required.
    """
    if not email or not password:
        raise EaLoginError("AuthError", "email and password are required")

    pc_sign = generate_pc_sign(seed)
    http = requests.Session()
    http.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})

    base = existing or EaSession()
    if base.trust_cookies:
        _apply_trust_cookies(http, base.trust_cookies)

    start = _juno_auth_start_url(pc_sign)
    r1 = http.get(start, timeout=timeout, allow_redirects=True)
    if "signin.ea.com" not in r1.url:
        raise EaLoginError("LoginFailed", f"expected signin.ea.com, got {r1.url[:120]}")

    post_url = r1.url
    data = {
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
    r2 = http.post(post_url, data=data, timeout=timeout, allow_redirects=True)
    body = r2.text or ""
    _diag("password-post", r2)

    if INVALID_CREDS_RE.search(body):
        raise EaLoginError(
            "AuthError",
            "EA rejected the email or password — verify credentials in a browser at signin.ea.com",
        )

    if CAPTCHA_RE.search(body) and "thirdPartyCaptchaResponse" not in body:
        raise EaLoginError(
            "AuthError",
            "EA sign-in requires captcha from this IP — log in once in EA App or a browser, then retry",
        )

    # EA wants an email code. Click "Send Code" (codeType=EMAIL + _eventId=submit),
    # stash the flow state, and hand off to /eacode. The trust cookie we set on
    # the verify step means EA won't ask again after this.
    if EMAIL_CODE_RADIO_RE.search(body) or SEND_CODE_RE.search(body):
        r_send = http.post(
            r2.url,
            data={"codeType": "EMAIL", "_eventId": "submit"},
            timeout=timeout,
            allow_redirects=True,
        )
        verify_body = r_send.text or ""
        if not VERIFY_CODE_RE.search(verify_body):
            raise EaLoginError("LoginFailed", "EA did not return the code-entry page after requesting a code")
        save_pending({
            "email": email.strip(),
            "seed": seed,
            "pc_sign": pc_sign,
            "machine_hash": base.machine_hash or "",
            "verify_url": r_send.url,
            "cookies": requests.utils.dict_from_cookiejar(http.cookies),
        })
        raise EaLoginError(
            "EmailCodePending",
            f"EA emailed a verification code to {masked_email(email)} — submit it with /eacode <code>.",
        )

    return _finish_login(http, body, r2.url, email, pc_sign, base, seed, timeout)


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
    """Shared tail: accept terms, follow the redirect for remid + trust cookies, persist."""
    if READ_ACCEPT_RE.search(body):
        r3 = http.post(
            post_url,
            data={"_readAccept": "on", "readAccept": "on", "_eventId": "accept"},
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
    """
    Resume a pending email verification: POST the code EA emailed (+ trust device)
    and finish the login. Raises EaLoginError on no-pending / bad code.
    """
    pending = load_pending()
    if not pending:
        raise EaLoginError("NoPendingVerification", "No EA verification is waiting — trigger a login first, then use /eacode.")

    digits = re.sub(r"\D", "", str(code or ""))
    if len(digits) < 4:
        raise EaLoginError("InvalidRequest", "Enter the numeric code EA emailed you.")

    http = requests.Session()
    http.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
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
