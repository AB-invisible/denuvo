"""
ea_pending.py — hold an in-progress EA email-verification so it can be resumed.

When EA asks for an email code, ea_login clicks "Send Code", stashes the HTTP
state here, and bails. The owner reads the code from their inbox and submits it
via /eacode; submit_verification_code() reloads this state and finishes the
login. One-and-done: EA's trust cookies get saved afterward.
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any, Optional

_LOCK = threading.Lock()


def pending_path() -> str:
    return os.environ.get("EA_PENDING_PATH", "/data/ea_pending.json").strip() or "/data/ea_pending.json"


def save_pending(data: dict[str, Any]) -> None:
    path = pending_path()
    with _LOCK:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        payload = {**data, "created_at": time.time()}
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp, path)


def load_pending() -> Optional[dict[str, Any]]:
    path = pending_path()
    with _LOCK:
        if not os.path.isfile(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None


def clear_pending() -> None:
    path = pending_path()
    with _LOCK:
        try:
            os.remove(path)
        except OSError:
            pass


def has_pending() -> bool:
    return load_pending() is not None


def masked_email(email: str) -> str:
    email = (email or "").strip()
    if "@" not in email:
        return email or "your email"
    local, domain = email.split("@", 1)
    shown = local[:2] if len(local) > 2 else local[:1]
    return f"{shown}{'*' * max(3, len(local) - len(shown))}@{domain}"
