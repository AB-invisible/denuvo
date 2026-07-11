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


class EaLoginError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


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

    if EMAIL_CODE_RADIO_RE.search(body):
        raise EaLoginError(
            "EmailVerificationRequired",
            "EA requires email verification on first login — open EA once in a browser, "
            "complete verification, then retry (or seed trust cookies on the service volume).",
        )

    if READ_ACCEPT_RE.search(body):
        r3 = http.post(
            r2.url,
            data={"_readAccept": "on", "readAccept": "on", "_eventId": "accept"},
            timeout=timeout,
            allow_redirects=True,
        )
        body = r3.text or ""
        post_url = r3.url
    else:
        post_url = r2.url

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
