"""
Pure-Python EA / Origin Denuvo token minter (Linux/Railway compatible).

Reverse-engineered from anadius token_generator v1.5.1 bytecode analysis.
Uses remid + pc_sign automatic login (no pymem / EA Desktop required).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import random
import re
import secrets
import string
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import requests

LICENSE_URL = "https://proxy.novafusion.ea.com/licenses"
AUTH_URL = "https://accounts.ea.com/connect/auth"
TOKEN_URL = "https://accounts.ea.com/connect/token"

CLIENT_ID = "JUNO_PC_CLIENT"
CLIENT_SECRET = "4mRLtYMb6vq9qglomWEaT4ChxsXWcyqbQpuBNfMPOYOiDmYYQmjuaBsF2Zp0RyVeWkfqhE9TuGgAw7te"
REDIRECT_URI = "qrc:///html/login_successful.html"

DEFAULT_EA_APP_VERSION = "13.560.0.6073"
LICENSE_NS = "{http://ea.com/license}"

TICKET_RE = re.compile(
    r"^((?:[A-Za-z0-9_\-]{4}){40,}(?:[A-Za-z0-9_\-]{2}==|[A-Za-z0-9_\-]{3}=)?)\|(\d+)\|([a-zA-Z_\d]+)$"
)

PC_SIGN_KEYS = {
    "v1": b"ISa3dpGOc8wW7Adn4auACSQmaccrOyR2",
    "v2": b"nt5FfJbdPzNcl2pkC3zgjO43Knvscxft",
}

UA_AUTH = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) QtWebEngine/5.15.2 Chrome/83.0.4103.122 "
    "Safari/537.36 Origin/10.6.0.00000 EAApp/"
)
UA_TOKEN = "Mozilla/5.0 EA Download Manager Origin/10.6.0.00000"


class EaMintError(Exception):
    def __init__(self, code: str, message: str, logs: str = ""):
        super().__init__(message)
        self.code = code
        self.logs = logs


@dataclass
class EaConfig:
    remid: str
    login_signature: str
    login_sv: str = "v2"
    machine_hash: str = ""
    ea_app_version: str = DEFAULT_EA_APP_VERSION
    access_token: str = ""  # optional: skip login if pre-seeded

    @classmethod
    def from_env(cls) -> "EaConfig":
        remid = os.environ.get("EA_LOGIN_REMID", "").strip()
        sig = os.environ.get("EA_LOGIN_SIGNATURE", "").strip()
        return cls(
            remid=remid,
            login_signature=sig,
            login_sv=os.environ.get("EA_LOGIN_SV", "v2").strip() or "v2",
            machine_hash=os.environ.get("EA_MACHINE_HASH", "").strip(),
            ea_app_version=os.environ.get("EA_APP_VERSION", DEFAULT_EA_APP_VERSION).strip() or DEFAULT_EA_APP_VERSION,
            access_token=os.environ.get("EA_ACCESS_TOKEN", "").strip(),
        )


def url_base64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _ea_timestamp() -> str:
    now = datetime.now(timezone.utc)
    ms = now.microsecond // 1000
    return f"{now.year}-{now.month}-{now.day} {now.hour}:{now.minute}:{now.second}:{ms}"


def refresh_pc_sign(stored_signature: str, sv: str = "v2") -> str:
    """
    Refresh timestamp + HMAC on a stored pc_sign from Origin Helper / EA app.
    Falls back to the stored value if it cannot be parsed.
    """
    if "." not in stored_signature:
        return stored_signature
    payload_b64, _old_sig = stored_signature.split(".", 1)
    pad = "=" * (-len(payload_b64) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + pad).decode("utf-8"))
    except Exception:
        return stored_signature

    payload["ts"] = _ea_timestamp()
    payload["sv"] = sv
    new_payload_b64 = url_base64(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    key = PC_SIGN_KEYS.get(sv, PC_SIGN_KEYS["v2"])
    sig = hmac.new(key, new_payload_b64.encode("ascii"), hashlib.sha256).digest()
    return f"{new_payload_b64}.{url_base64(sig)}"


def _pkce_pair() -> tuple[str, str]:
    verifier = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(64))
    challenge = url_base64(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def login_automatic(cfg: EaConfig, sess: requests.Session) -> str:
    if not cfg.remid or not cfg.login_signature:
        raise EaMintError("AuthError", "EA_LOGIN_REMID and EA_LOGIN_SIGNATURE are required")

    version = cfg.ea_app_version
    pc_sign = refresh_pc_sign(cfg.login_signature, cfg.login_sv)
    code_verifier, code_challenge = _pkce_pair()
    nonce = str(random.randint(-2_147_483_648, 2_147_483_647))

    params = {
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "client_id": CLIENT_ID,
        "response_type": "code id_token",
        "redirect_uri": REDIRECT_URI,
        "display": "junoClient/login",
        "locale": "en_US",
        "nonce": nonce,
        "pc_sign": pc_sign,
        "sbiod_enabled": "true",
    }
    headers = {
        "User-Agent": UA_AUTH + version,
        "Cookie": f"remid={cfg.remid}",
    }

    r1 = sess.get(AUTH_URL, params=params, headers=headers, allow_redirects=False, timeout=30)
    location = r1.headers.get("Location", "")
    if r1.status_code not in (301, 302, 303, 307, 308) or not location:
        raise EaMintError(
            "AuthError",
            "EA auth redirect failed — refresh remid/signature",
            logs=f"status={r1.status_code} body={r1.text[:500]}",
        )

    if "#code=" in location:
        code = location.split("#code=", 1)[1].split("&", 1)[0]
    elif "code=" in location:
        code = location.split("code=", 1)[1].split("&", 1)[0]
    else:
        raise EaMintError("AuthError", "EA auth returned no authorization code", logs=f"location={location[:300]}")

    data = {
        "grant_type": "authorization_code",
        "code": code,
        "code_verifier": code_verifier,
        "token_format": "JWS",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "redirect_uri": REDIRECT_URI,
    }
    r2 = sess.post(
        TOKEN_URL,
        headers={"User-Agent": UA_TOKEN, "Content-Type": "application/x-www-form-urlencoded"},
        data=data,
        allow_redirects=False,
        timeout=30,
    )
    if r2.status_code != 200:
        raise EaMintError("AuthError", "EA token exchange failed", logs=r2.text[:500])

    body = r2.json()
    token = body.get("access_token", "")
    if not token:
        raise EaMintError("AuthError", "EA access token missing in response", logs=str(body)[:300])
    return token


_token_cache: dict[str, object] = {"token": "", "at": 0.0}


def get_access_token(cfg: EaConfig, sess: requests.Session) -> str:
    if cfg.access_token:
        return cfg.access_token
    cached = str(_token_cache.get("token", ""))
    if cached and time.time() - float(_token_cache.get("at", 0)) < 3.5 * 3600:
        return cached
    token = login_automatic(cfg, sess)
    _token_cache["token"] = token
    _token_cache["at"] = time.time()
    return token


def normalize_ticket(raw: str, content_id: Optional[int], engine: Optional[str]) -> tuple[str, int, str]:
    text = (raw or "").strip().replace("\r", "").replace("\n", "")
    m = TICKET_RE.match(text)
    if m:
        cid = int(m.group(2))
        eng = m.group(3)
        # FC 26 tickets use TICKET|0|<contentId> — content id is the third segment.
        if cid == 0 and eng.isdigit():
            cid = int(eng)
            eng = "0"
        return m.group(1), cid, eng
    if not content_id or content_id <= 0:
        raise EaMintError("InvalidRequest", "ticket must be TICKET|contentId|engine or provide contentId")
    if not engine:
        raise EaMintError("InvalidRequest", "engine is required when ticket is not a full pipe-separated line")
    if len(text) < 40:
        raise EaMintError("InvalidRequest", "ticket blob too short")
    return text, content_id, engine


def _parse_game_token(xml_text: str) -> str:
    root = ET.fromstring(xml_text)
    node = root.find(f".//{LICENSE_NS}GameToken")
    if node is None or not (node.text or "").strip():
        raise EaMintError("Failure", "response XML had no GameToken", logs=xml_text[:500])
    return node.text.strip()


def _classify_xml_error(xml_text: str) -> EaMintError:
    low = xml_text.lower()
    if "cg_limit_exceeded" in low or "daily limit" in low:
        return EaMintError("LimitExceeded", "daily activation limit reached for this EA account", logs=xml_text[:500])
    if "not_entitled" in low or "don't own" in low:
        return EaMintError("NotEntitled", "EA account does not own this game", logs=xml_text[:500])
    if "authentication_failed" in low:
        return EaMintError("AuthError", "EA authentication failed during license request", logs=xml_text[:500])
    if "validation_failed" in low or "nucleus_exception" in low:
        return EaMintError("InvalidRequest", "bad ticket or invalid content/engine", logs=xml_text[:500])
    return EaMintError("Failure", "token generation failed", logs=xml_text[:500])


def generate_token(
    cfg: EaConfig,
    ticket_blob: str,
    content_id: int,
    engine: str,
    sess: Optional[requests.Session] = None,
) -> str:
    if not cfg.machine_hash:
        raise EaMintError(
            "NotConfigured",
            "EA_MACHINE_HASH is required on Linux — copy MachineHash from your EA license file "
            "(token_generator Options, or Origin Helper 'Get info from license')",
        )

    own_sess = sess is None
    sess = sess or requests.Session()
    access_token = get_access_token(cfg, sess)

    headers = {
        "User-Agent": f"Mozilla/5.0 EA Download Manager Origin/{cfg.ea_app_version}",
        "X-Requester-Id": f"EADesktop/{cfg.ea_app_version}",
    }
    params = {
        "contentId": str(content_id),
        "machineHash": cfg.machine_hash,
        "ea_eadmtoken": access_token,
        "requestToken": ticket_blob,
        "requestType": "Origin Online Activation",
    }

    last_logs = ""
    try:
        for attempt in range(10):
            try:
                resp = sess.get(LICENSE_URL, params=params, headers=headers, timeout=30)
            except requests.RequestException as e:
                raise EaMintError("ServiceUnavailable", f"EA license HTTP failed: {e}") from e

            ctype = (resp.headers.get("content-type") or "").lower()
            last_logs = f"status={resp.status_code} ctype={ctype}\n{resp.text[:800]}"

            if resp.status_code == 404:
                raise EaMintError("InvalidRequest", "license endpoint returned 404", logs=last_logs)

            if "text/html" in ctype:
                if attempt < 9:
                    time.sleep(min(5, 1 + attempt))
                    continue
                raise EaMintError("Failure", "EA returned HTML instead of XML", logs=last_logs)

            if "application/xml" in ctype or resp.text.strip().startswith("<?xml") or "<" in resp.text[:50]:
                if "GameToken" in resp.text:
                    return _parse_game_token(resp.text)
                raise _classify_xml_error(resp.text)

            if attempt < 9:
                time.sleep(min(5, 1 + attempt))
                continue

        raise EaMintError("Failure", "token generation failed after retries", logs=last_logs)
    finally:
        if own_sess:
            sess.close()


def mint_ticket(
    ticket: str,
    content_id: Optional[int] = None,
    engine: Optional[str] = None,
    cfg: Optional[EaConfig] = None,
) -> str:
    cfg = cfg or EaConfig.from_env()
    blob, cid, eng = normalize_ticket(ticket, content_id, engine)
    return generate_token(cfg, blob, cid, eng)
