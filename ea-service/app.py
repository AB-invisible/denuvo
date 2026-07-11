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

from ea_minter import EaConfig, EaMintError, mint_ticket

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
    cfg = EaConfig.from_env()
    if body.remid:
        cfg.remid = body.remid.strip()
    if body.signature:
        cfg.login_signature = body.signature.strip()
    if body.machineHash:
        cfg.machine_hash = body.machineHash.strip()
    return cfg


@app.get("/health")
def health() -> dict:
    cfg = EaConfig.from_env()
    ready = bool(cfg.remid and cfg.login_signature and cfg.machine_hash)
    return {
        "ok": True,
        "tool": True,
        "mode": "python",
        "configured": ready,
        "has_remind": bool(cfg.remid),
        "has_signature": bool(cfg.login_signature),
        "has_machine_hash": bool(cfg.machine_hash),
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
            status = {
                "LimitExceeded": 429,
                "NotEntitled": 502,
                "InvalidRequest": 400,
                "AuthError": 401,
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
