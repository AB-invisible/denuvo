"""
EaTokenService — Linux/Railway HTTP service for EA Denuvo token minting.

Pure Python reimplementation of anadius token_generator v1.5.1 (no Windows exe).
Deploy on Railway the same way as ubisoft-service/.
"""

from __future__ import annotations

import hmac
import os
import threading
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ea_auth import bootstrap_session, ensure_default_account_configured, resolve_config
from ea_login import EaLoginError, submit_verification_code
from ea_minter import EaConfig, EaMintError, mint_ticket
from ea_pending import has_pending, load_pending, masked_email
from ea_session import load_session, merge_env_session

app = FastAPI(title="EaTokenService", version="2.0.0")
RUN_LOCK = threading.Lock()


def env(key: str, default: str = "") -> str:
    v = os.environ.get(key, "").strip()
    return v if v else default


API_KEY = env("EA_SERVICE_KEY")


class TokenRequest(BaseModel):
    ticket: str = Field(..., min_length=10)
    contentId: Optional[int] = None
    engine: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = None
    remid: Optional[str] = None
    signature: Optional[str] = None
    machineHash: Optional[str] = None


class TokenResponse(BaseModel):
    token: str


class VerifyCodeRequest(BaseModel):
    code: str = Field(..., min_length=4, max_length=12)


class ErrorResponse(BaseModel):
    error: str
    code: str = "Failure"
    logs: Optional[str] = None


def fixed_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def require_api_key(x_api_key: Optional[str]) -> None:
    if not API_KEY:
        raise HTTPException(status_code=503, detail="service not configured (missing EA_SERVICE_KEY)")
    if not x_api_key or not fixed_time_equals(x_api_key, API_KEY):
        raise HTTPException(status_code=401, detail="unauthorized")


def build_config(body: TokenRequest) -> EaConfig:
    return resolve_config(
        email=body.email,
        password=body.password,
        remid=body.remid,
        signature=body.signature,
        machine_hash=body.machineHash,
    )


@app.on_event("startup")
def warm_default_session() -> None:
    try:
        ensure_default_account_configured()
    except Exception:
        pass


@app.get("/health")
def health() -> dict:
    stored = merge_env_session(load_session())
    has_env_creds = bool(env("EA_EMAIL") and env("EA_PASSWORD"))
    has_manual = bool(env("EA_LOGIN_REMID") and env("EA_LOGIN_SIGNATURE") and env("EA_MACHINE_HASH"))
    ready = stored.is_complete() or has_env_creds or has_manual
    return {
        "ok": True,
        "tool": True,
        "mode": "python",
        "configured": ready,
        "has_remind": bool(stored.remid or env("EA_LOGIN_REMID")),
        "has_signature": bool(stored.login_signature or env("EA_LOGIN_SIGNATURE")),
        "has_machine_hash": bool(stored.machine_hash or env("EA_MACHINE_HASH")),
        "has_email_password": has_env_creds,
        "session_email": stored.email or None,
    }


def _mint_error_response(e: EaMintError):
    status = {
        "LimitExceeded": 429,
        "NotEntitled": 502,
        "InvalidRequest": 400,
        "AuthError": 401,
        "LoginFailed": 401,
        "EmailVerificationRequired": 401,
        # EA emailed a code; owner must submit it via /eacode. 409 = needs action.
        "EmailCodePending": 409,
        "InvalidCode": 400,
        "NoPendingVerification": 409,
        "NotConfigured": 503,
        "Timeout": 504,
        "ServiceUnavailable": 503,
    }.get(e.code, 502)
    return JSONResponse(
        status_code=status,
        content=ErrorResponse(error=str(e), code=e.code, logs=e.logs or None).model_dump(),
    )


@app.post("/ea/token", response_model=None)
def mint_token(body: TokenRequest, x_api_key: Optional[str] = Header(default=None)):
    require_api_key(x_api_key)
    try:
        cfg = build_config(body)
    except EaMintError as e:
        return _mint_error_response(e)

    with RUN_LOCK:
        try:
            token = mint_ticket(body.ticket, body.contentId, body.engine, cfg)
            return TokenResponse(token=token)
        except EaMintError as e:
            # Stale remid on volume — force re-login when creds are available.
            if e.code == "AuthError" and (body.email and body.password):
                try:
                    bootstrap_session(body.email.strip(), body.password, force=True)
                    cfg = build_config(body)
                    token = mint_ticket(body.ticket, body.contentId, body.engine, cfg)
                    return TokenResponse(token=token)
                except EaMintError as e2:
                    e = e2
            return _mint_error_response(e)


@app.post("/ea/login", response_model=None)
def ea_login(x_api_key: Optional[str] = Header(default=None)):
    """
    Owner-triggered login (via bot /ealogin). Forces a fresh sign-in of the env
    EA account. If EA wants an email code, this emails it and returns
    status=code_pending — the owner then submits it with /eacode.
    """
    require_api_key(x_api_key)
    email = env("EA_EMAIL")
    password = env("EA_PASSWORD")
    if not (email and password):
        return _mint_error_response(EaMintError("NotConfigured", "Set EA_EMAIL / EA_PASSWORD on the ea-service first."))
    with RUN_LOCK:
        try:
            sess = bootstrap_session(email, password, force=True)
            return {"ok": True, "status": "logged_in", "email": sess.email or email}
        except EaMintError as e:
            if e.code == "EmailCodePending":
                return JSONResponse(
                    status_code=409,
                    content={"ok": False, "status": "code_pending", "email": masked_email(email), "message": str(e)},
                )
            return _mint_error_response(e)


@app.post("/ea/verify-code", response_model=None)
def ea_verify_code(body: VerifyCodeRequest, x_api_key: Optional[str] = Header(default=None)):
    """Owner submits the emailed code (bot /eacode) to finish a pending verification."""
    require_api_key(x_api_key)
    with RUN_LOCK:
        try:
            sess = submit_verification_code(body.code)
            return {"ok": True, "status": "logged_in", "email": sess.email}
        except EaLoginError as e:
            return _mint_error_response(EaMintError(e.code, str(e)))


@app.get("/ea/verify-status")
def ea_verify_status(x_api_key: Optional[str] = Header(default=None)):
    """Whether a code is currently awaited (bot can poll / show state)."""
    require_api_key(x_api_key)
    pending = load_pending()
    return {"ok": True, "pending": bool(pending), "email": masked_email(pending.get("email", "")) if pending else None}


if __name__ == "__main__":
    import uvicorn

    host = env("EA_HOST", "0.0.0.0")
    port = int(env("PORT", env("EA_PORT", "8081")) or "8081")
    uvicorn.run("app:app", host=host, port=port, log_level="info")
