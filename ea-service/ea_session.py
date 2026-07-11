"""
Persist EA login session (remid, pc_sign, machine_hash, trust cookies) on a
Railway volume — same idea as ubisoft-service's LoginStore.dat seeding.
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import asdict, dataclass, field
from typing import Any, Optional

_LOCK = threading.Lock()


def session_path() -> str:
    return os.environ.get("EA_SESSION_PATH", "/data/ea_session.json").strip() or "/data/ea_session.json"


@dataclass
class EaSession:
    email: str = ""
    remid: str = ""
    login_signature: str = ""
    login_sv: str = "v2"
    machine_hash: str = ""
    trust_cookies: dict[str, str] = field(default_factory=dict)
    updated_at: float = 0.0

    def is_complete(self) -> bool:
        return bool(self.remid and self.login_signature and self.machine_hash)


def load_session() -> EaSession:
    path = session_path()
    with _LOCK:
        if not os.path.isfile(path):
            return EaSession()
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw: dict[str, Any] = json.load(f)
            return EaSession(
                email=str(raw.get("email", "") or ""),
                remid=str(raw.get("remid", "") or ""),
                login_signature=str(raw.get("login_signature", "") or ""),
                login_sv=str(raw.get("login_sv", "v2") or "v2"),
                machine_hash=str(raw.get("machine_hash", "") or ""),
                trust_cookies={str(k): str(v) for k, v in (raw.get("trust_cookies") or {}).items()},
                updated_at=float(raw.get("updated_at", 0) or 0),
            )
        except Exception:
            return EaSession()


def save_session(sess: EaSession) -> None:
    path = session_path()
    with _LOCK:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        payload = {
            "email": sess.email,
            "remid": sess.remid,
            "login_signature": sess.login_signature,
            "login_sv": sess.login_sv,
            "machine_hash": sess.machine_hash,
            "trust_cookies": sess.trust_cookies,
            "updated_at": sess.updated_at,
        }
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        os.replace(tmp, path)


def merge_env_session(sess: EaSession) -> EaSession:
    """Overlay explicit env vars (manual bootstrap) onto stored session."""
    remid = os.environ.get("EA_LOGIN_REMID", "").strip()
    sig = os.environ.get("EA_LOGIN_SIGNATURE", "").strip()
    mh = os.environ.get("EA_MACHINE_HASH", "").strip()
    sv = os.environ.get("EA_LOGIN_SV", "").strip()
    email = os.environ.get("EA_EMAIL", "").strip()

    if email:
        sess.email = email
    if remid:
        sess.remid = remid
    if sig:
        sess.login_signature = sig
    if mh:
        sess.machine_hash = mh
    if sv:
        sess.login_sv = sv
    return sess
