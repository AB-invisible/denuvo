"""
Resolve EA credentials: env vars → persisted session → email/password bootstrap.
"""

from __future__ import annotations

import os
import time
from typing import Optional

import requests

from ea_login import EaLoginError, login_with_email_password, login_with_one_time_code
from ea_minter import EaConfig, EaMintError, login_automatic, refresh_pc_sign
from ea_pc_sign import generate_machine_hash, generate_pc_sign
from ea_session import EaSession, load_session, merge_env_session, save_session

# In-memory cache: avoid re-login on every mint within the same process.
_ACCOUNT_CACHE: dict[str, float] = {}
_CACHE_TTL = 3 * 3600


def _account_seed(email: str, password: str) -> str:
    return f"{email.strip().lower()}|{password}"


def _cache_key(email: str) -> str:
    return email.strip().lower()


def session_from_stored(stored: EaSession) -> EaConfig:
    return EaConfig(
        remid=stored.remid,
        login_signature=stored.login_signature,
        login_sv=stored.login_sv or "v2",
        machine_hash=stored.machine_hash,
        trust_cookies=dict(stored.trust_cookies or {}),
    )


def _use_otp_first(force: bool = False) -> bool:
    """Railway/datacenter IPs hit FunCaptcha on password login — use email OTP instead."""
    if force:
        return True
    v = os.environ.get("EA_LOGIN_OTP_FIRST", "").strip().lower()
    if v in ("0", "false", "no"):
        return False
    if v in ("1", "true", "yes"):
        return True
    return bool(os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("RAILWAY_PROJECT_ID"))


def bootstrap_session(email: str, password: str, force: bool = False) -> EaSession:
    email = email.strip()
    key = _cache_key(email)
    now = time.time()
    if not force and key in _ACCOUNT_CACHE and now - _ACCOUNT_CACHE[key] < _CACHE_TTL:
        stored = merge_env_session(load_session())
        if stored.is_complete() and stored.email.lower() == email.lower():
            return stored

    stored = merge_env_session(load_session())
    seed = _account_seed(email, password)

    if stored.is_complete() and stored.email.lower() == email.lower() and not force:
        _ACCOUNT_CACHE[key] = now
        return stored

    if stored.is_complete() and stored.email.lower() != email.lower():
        stored = EaSession()

    if not stored.machine_hash:
        stored.machine_hash = generate_machine_hash(seed)
    if not stored.login_signature:
        stored.login_signature = generate_pc_sign(seed)

    try:
        if _use_otp_first(force):
            stored = login_with_one_time_code(email, password, seed, existing=stored)
        else:
            stored = login_with_email_password(email, password, seed, existing=stored)
    except EaLoginError as e:
        # Password rejected on bot IP — fall back to emailed one-time code.
        if e.code == "AuthError" and not _use_otp_first(force):
            try:
                stored = login_with_one_time_code(email, password, seed, existing=stored)
            except EaLoginError as e2:
                raise EaMintError(e2.code, str(e2)) from e2
        else:
            raise EaMintError(e.code, str(e)) from e

    _ACCOUNT_CACHE[key] = time.time()
    return stored


def resolve_config(
    email: Optional[str] = None,
    password: Optional[str] = None,
    remid: Optional[str] = None,
    signature: Optional[str] = None,
    machine_hash: Optional[str] = None,
) -> EaConfig:
    """
    Build EaConfig for minting. Priority:
      1. Explicit request overrides (remid/signature/machineHash)
      2. Env vars (EA_LOGIN_* or EA_EMAIL/PASSWORD bootstrap)
      3. Persisted /data/ea_session.json
      4. Email/password bootstrap (request body or EA_EMAIL/EA_PASSWORD)
    """
    stored = merge_env_session(load_session())

    env_email = os.environ.get("EA_EMAIL", "").strip()
    env_password = os.environ.get("EA_PASSWORD", "")

    use_email = (email or "").strip() or env_email
    use_password = password if password is not None and password != "" else env_password

    if remid:
        stored.remid = remid.strip()
    if signature:
        stored.login_signature = signature.strip()
    if machine_hash:
        stored.machine_hash = machine_hash.strip()

    if stored.is_complete() and not (use_email and use_password and stored.email.lower() != use_email.lower()):
        cfg = session_from_stored(stored)
        if remid:
            cfg.remid = remid.strip()
        if signature:
            cfg.login_signature = refresh_pc_sign(signature.strip(), stored.login_sv or "v2")
        if machine_hash:
            cfg.machine_hash = machine_hash.strip()
        return cfg

    if use_email and use_password:
        stored = bootstrap_session(use_email, use_password)
        return session_from_stored(stored)

    if stored.remid and stored.login_signature:
        cfg = session_from_stored(stored)
        if not cfg.machine_hash:
            raise EaMintError(
                "NotConfigured",
                "EA_MACHINE_HASH missing — set EA_EMAIL/EA_PASSWORD for auto-bootstrap "
                "or EA_MACHINE_HASH on the service",
            )
        return cfg

    raise EaMintError(
        "NotConfigured",
        "EA account not configured — set EA_EMAIL/EA_PASSWORD on ea-service, "
        "use /eaaccount add on the bot, or set EA_LOGIN_REMID + EA_LOGIN_SIGNATURE + EA_MACHINE_HASH",
    )


def import_remid_session(
    remid: str,
    email: str = "",
    password: str = "",
    extra_cookies: Optional[dict[str, str]] = None,
) -> EaSession:
    """
    Import remid (+ optional sid/osc trust cookies) from a browser JUNO login.
    Validates with the same OAuth+nonce flow used for token minting.
    """
    remid = remid.strip()
    if not remid:
        raise EaMintError("InvalidRequest", "remid cookie value is required")

    email = (email or os.environ.get("EA_EMAIL", "")).strip()
    password = password or os.environ.get("EA_PASSWORD", "")
    seed = _account_seed(email, password) if email and password else (email or "imported")
    machine_hash = generate_machine_hash(seed)
    signature = generate_pc_sign(seed)

    trust = {k: v.strip() for k, v in (extra_cookies or {}).items() if v and str(v).strip()}
    trust["remid"] = remid

    cfg = EaConfig(
        remid=remid,
        login_signature=signature,
        login_sv="v2",
        machine_hash=machine_hash,
        trust_cookies=trust,
    )
    from ea_minter import _http_session

    http = _http_session()
    try:
        login_automatic(cfg, http)
    except EaMintError as e:
        if e.code == "AuthError":
            raise EaMintError(
                "AuthError",
                "remid is expired or not a JUNO session — log in via the JUNO link in "
                "import_browser_session.py (or www.ea.com/login), then re-import.",
                logs=e.logs or str(e),
            ) from e
        raise

    out = EaSession(
        email=email,
        remid=remid,
        login_signature=signature,
        login_sv="v2",
        machine_hash=machine_hash,
        trust_cookies=trust,
        updated_at=time.time(),
    )
    save_session(out)
    if email:
        _ACCOUNT_CACHE[_cache_key(email)] = time.time()
    return out


def validate_stored_session(stored: Optional[EaSession] = None) -> bool:
    """Return True if persisted remid still works for JUNO token minting."""
    stored = stored or merge_env_session(load_session())
    if not stored.is_complete():
        return False
    try:
        from ea_minter import _http_session

        login_automatic(session_from_stored(stored), _http_session())
        return True
    except EaMintError:
        return False


def ensure_default_account_configured() -> EaSession:
    """
    Startup hook: validate existing volume session — never overwrite a good
    session with a failed Railway OTP/password bootstrap.
    """
    stored = merge_env_session(load_session())
    if stored.is_complete():
        if validate_stored_session(stored):
            print("[ea-service] persisted EA session is valid", flush=True)
        else:
            print(
                "[ea-service] persisted EA session is stale — "
                "session keeper or import_browser_session.py will refresh it",
                flush=True,
            )
        return stored

    email = os.environ.get("EA_EMAIL", "").strip()
    password = os.environ.get("EA_PASSWORD", "")
    if email and password:
        try:
            return bootstrap_session(email, password)
        except EaMintError as e:
            print(f"[ea-service] auto-bootstrap skipped: {e}", flush=True)
    return stored
