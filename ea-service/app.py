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
from ea_minter import EaConfig, EaMintError, mint_ticket
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


@app.post("/ea/token", response_model=None)
def mint_token(body: TokenRequest, x_api_key: Optional[str] = Header(default=None)):
    require_api_key(x_api_key)
    cfg = build_config(body)

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
            status = {
                "LimitExceeded": 429,
                "NotEntitled": 502,
                "InvalidRequest": 400,
                "AuthError": 401,
                "EmailVerificationRequired": 401,
                "NotConfigured": 503,
                "Timeout": 504,
                "ServiceUnavailable": 503,
            }.get(e.code, 502)
            return JSONResponse(
                status_code=status,
                content=ErrorResponse(error=str(e), code=e.code, logs=e.logs or None).model_dump(),
            )


if __name__ == "__main__":
    import uvicorn

    host = env("EA_HOST", "0.0.0.0")
    port = int(env("PORT", env("EA_PORT", "8081")) or "8081")
    uvicorn.run("app:app", host=host, port=port, log_level="info")
