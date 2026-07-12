#!/usr/bin/env python3
"""
One-shot: open EA login in a real browser, grab remid from any .ea.com origin,
validate + save it on ea-service (Railway volume).

Run locally (needs your machine's browser — Railway IPs can't do this):

  pip install playwright requests
  playwright install chromium

  set EA_SERVICE_URL=https://ea-service-production.up.railway.app
  set EA_SERVICE_KEY=...
  set EA_EMAIL=pokemgo300@gmail.com
  python import_browser_session.py

Optional: set EA_PASSWORD to auto-fill (you may still need to solve captcha/2FA).
"""

from __future__ import annotations

import json
import os
import sys
import time
from urllib.parse import urlparse

import requests

LOGIN_URLS = (
    "https://www.ea.com/login",
    "https://accounts.ea.com/connect/auth?client_id=ORIGIN_SPA_ID&response_type=code"
    "&redirect_uri=https://www.ea.com/login/check&locale=en_US&display=originX/login",
    "https://signin.ea.com/p/juno/login",
)

EA_ORIGINS = ("https://www.ea.com", "https://accounts.ea.com", "https://signin.ea.com")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _find_remid(cookies: list[dict]) -> str:
    for c in cookies:
        if c.get("name") == "remid" and c.get("value"):
            return str(c["value"])
    return ""


def _collect_remid(context) -> str:
    for origin in EA_ORIGINS:
        try:
            jar = context.cookies(origin)
            remid = _find_remid(jar)
            if remid:
                print(f"[import] found remid on {origin}", flush=True)
                return remid
        except Exception:
            pass
    # Fallback: all cookies in context
    try:
        remid = _find_remid(context.cookies())
        if remid:
            print("[import] found remid in browser context", flush=True)
            return remid
    except Exception:
        pass
    return ""


def _try_autofill(page, email: str, password: str) -> None:
    if not email:
        return
    for sel in ('input[type="email"]', 'input[name="email"]', '#email', 'input[id*="email"]'):
        try:
            loc = page.locator(sel).first
            if loc.count() and loc.is_visible(timeout=2000):
                loc.fill(email)
                break
        except Exception:
            continue
    if password:
        for sel in ('input[type="password"]', 'input[name="password"]', '#password'):
            try:
                loc = page.locator(sel).first
                if loc.count() and loc.is_visible(timeout=2000):
                    loc.fill(password)
                    break
            except Exception:
                continue
        for sel in ('button[type="submit"]', 'input[type="submit"]', 'button:has-text("Sign in")'):
            try:
                loc = page.locator(sel).first
                if loc.count() and loc.is_visible(timeout=2000):
                    loc.click()
                    break
            except Exception:
                continue


def grab_remid_interactive(timeout_sec: int = 180) -> str:
    from playwright.sync_api import sync_playwright

    email = _env("EA_EMAIL")
    password = _env("EA_PASSWORD")
    headless = _env("EA_IMPORT_HEADLESS", "0").lower() in ("1", "true", "yes")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless, channel="chrome" if not headless else None)
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
            locale="en-US",
        )
        page = context.new_page()
        loaded = False
        for url in LOGIN_URLS:
            try:
                print(f"[import] trying {url}", flush=True)
                page.goto(url, wait_until="domcontentloaded", timeout=45000)
                loaded = True
                break
            except Exception as e:
                print(f"[import] {url} failed: {e}", flush=True)
        if not loaded:
            browser.close()
            raise RuntimeError("Could not load any EA login page — check network/adblock.")

        _try_autofill(page, email, password)
        print(
            "[import] Log in in the browser window if needed. "
            f"Waiting up to {timeout_sec}s for remid cookie...",
            flush=True,
        )

        deadline = time.time() + timeout_sec
        remid = ""
        while time.time() < deadline:
            remid = _collect_remid(context)
            if remid:
                break
            time.sleep(2)

        browser.close()
        if not remid:
            raise RuntimeError(
                "No remid cookie found. Log in at www.ea.com/login, then re-run this script."
            )
        return remid


def upload_remid(remid: str) -> dict:
    base = _env("EA_SERVICE_URL", "https://ea-service-production.up.railway.app").rstrip("/")
    key = _env("EA_SERVICE_KEY")
    if not key:
        raise RuntimeError("Set EA_SERVICE_KEY (same value as on Railway ea-service).")

    r = requests.post(
        f"{base}/ea/session/import",
        headers={"X-Api-Key": key, "Content-Type": "application/json", "Accept": "application/json"},
        json={"remid": remid, "email": _env("EA_EMAIL") or None},
        timeout=60,
    )
    try:
        body = r.json()
    except Exception:
        body = {"error": r.text[:500]}
    if r.status_code >= 400:
        raise RuntimeError(f"ea-service rejected import ({r.status_code}): {body}")
    return body


def main() -> int:
    remid = _env("EA_REMID")
    if not remid:
        remid = grab_remid_interactive()
    else:
        print("[import] using EA_REMID from environment", flush=True)

    print(f"[import] remid length={len(remid)}", flush=True)
    result = upload_remid(remid)
    print(json.dumps(result, indent=2), flush=True)

    # Verify health
    base = _env("EA_SERVICE_URL", "https://ea-service-production.up.railway.app").rstrip("/")
    h = requests.get(f"{base}/health", timeout=30).json()
    print(f"[import] health: configured={h.get('configured')} has_remind={h.get('has_remind')} build={h.get('login_build')}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr, flush=True)
        raise SystemExit(1)
