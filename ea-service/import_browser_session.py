#!/usr/bin/env python3
"""
Grab a JUNO-compatible remid from a real browser and upload to ea-service.

The remid from www.ea.com alone can expire quickly or fail minting — this opens
the same JUNO_PC_CLIENT auth URL the token minter uses, so the cookie works.

  pip install playwright requests
  playwright install chromium
  python import_browser_session.py
"""

from __future__ import annotations

import json
import os
import sys
import time

import requests

TRUST_NAMES = frozenset({"remid", "sid", "_nx_mpcid", "osc"})
EA_ORIGINS = ("https://www.ea.com", "https://accounts.ea.com", "https://signin.ea.com")
PROFILE_DIR = os.path.join(os.path.expanduser("~"), "AppData", "Local", "GameGen", "ea-browser-profile")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _juno_login_url(email: str, password: str) -> str:
    from ea_pc_sign import generate_pc_sign

    seed = f"{email.strip().lower()}|{password}"
    pc_sign = generate_pc_sign(seed, "v2")
    return (
        "https://accounts.ea.com/connect/auth"
        f"?client_id=JUNO_PC_CLIENT"
        f"&response_type=code%20id_token"
        f"&redirect_uri=qrc%3A%2F%2F%2Fhtml%2Flogin_successful.html"
        f"&display=junoClient%2Flogin"
        f"&locale=en_US"
        f"&pc_sign={requests.utils.quote(pc_sign, safe='')}"
        f"&sbiod_enabled=true"
    )


def _find_remid(cookies: list[dict]) -> str:
    for c in cookies:
        if c.get("name") == "remid" and c.get("value"):
            return str(c["value"])
    return ""


def _collect_trust(context) -> dict[str, str]:
    out: dict[str, str] = {}
    for origin in EA_ORIGINS:
        try:
            for c in context.cookies(origin):
                name = c.get("name", "")
                val = c.get("value", "")
                if name in TRUST_NAMES and val:
                    out[name] = str(val)
        except Exception:
            pass
    try:
        for c in context.cookies():
            name = c.get("name", "")
            val = c.get("value", "")
            if name in TRUST_NAMES and val:
                out[name] = str(val)
    except Exception:
        pass
    return out


def _try_autofill(page, email: str, password: str) -> None:
    if not email:
        return
    for sel in ('input[type="email"]', 'input[name="email"]', '#email'):
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
        for sel in ('button[type="submit"]', 'button:has-text("Sign in")', 'input[type="submit"]'):
            try:
                loc = page.locator(sel).first
                if loc.count() and loc.is_visible(timeout=2000):
                    loc.click()
                    break
            except Exception:
                continue


def validate_local(remid: str, trust: dict[str, str]) -> bool:
    """Quick check: remid works for JUNO OAuth before uploading to Railway."""
    try:
        from ea_pc_sign import generate_machine_hash, generate_pc_sign
        from ea_minter import EaConfig, _http_session, login_automatic

        email = _env("EA_EMAIL")
        password = _env("EA_PASSWORD")
        seed = f"{email.strip().lower()}|{password}" if email and password else (email or "imported")
        cfg = EaConfig(
            remid=remid,
            login_signature=generate_pc_sign(seed, "v2"),
            login_sv="v2",
            machine_hash=generate_machine_hash(seed),
            trust_cookies=trust,
        )
        login_automatic(cfg, _http_session())
        return True
    except Exception as e:
        print(f"[import] local validation failed: {e}", flush=True)
        return False


def grab_session_interactive(timeout_sec: int = 300) -> tuple[str, dict[str, str]]:
    from playwright.sync_api import sync_playwright

    email = _env("EA_EMAIL")
    password = _env("EA_PASSWORD")
    headless = _env("EA_IMPORT_HEADLESS", "0").lower() in ("1", "true", "yes")

    login_urls = []
    if email and password:
        login_urls.append(_juno_login_url(email, password))
    login_urls.extend(
        [
            "https://www.ea.com/login",
            "https://signin.ea.com/p/juno/login",
        ]
    )

    with sync_playwright() as p:
        os.makedirs(PROFILE_DIR, exist_ok=True)
        # Always show browser when refreshing a stale profile
        if os.path.isdir(PROFILE_DIR):
            headless = False
        context = p.chromium.launch_persistent_context(
            PROFILE_DIR,
            headless=headless,
            channel="chrome" if not headless else None,
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
            locale="en-US",
        )
        page = context.pages[0] if context.pages else context.new_page()
        loaded = False
        for url in login_urls:
            try:
                print(f"[import] trying {url[:100]}...", flush=True)
                page.goto(url, wait_until="domcontentloaded", timeout=60000)
                loaded = True
                break
            except Exception as e:
                print(f"[import] failed: {e}", flush=True)
        if not loaded:
            context.close()
            raise RuntimeError("Could not load any EA login page.")

        _try_autofill(page, email, password)

        # Drop stale cookies so EA forces a fresh login instead of reusing expired remid
        try:
            context.clear_cookies()
            page.goto(login_urls[0], wait_until="domcontentloaded", timeout=60000)
            _try_autofill(page, email, password)
        except Exception:
            pass

        print(
            f"\n>>> LOG IN in the Chrome window that just opened (up to {timeout_sec}s).\n"
            f">>> Complete any 2FA — the script uploads automatically when login succeeds.\n",
            flush=True,
        )

        deadline = time.time() + timeout_sec
        trust: dict[str, str] = {}
        remid = ""
        last_remid = ""
        validated = False
        while time.time() < deadline:
            trust = _collect_trust(context)
            remid = trust.get("remid", "")
            if remid and remid != last_remid:
                last_remid = remid
                if validate_local(remid, trust):
                    print("[import] fresh remid validated OK", flush=True)
                    validated = True
                    break
            time.sleep(2)

        context.close()
        if not validated or not remid:
            raise RuntimeError(
                "Could not get a working JUNO remid — log in when the browser opens, "
                f"then re-run. Profile: {PROFILE_DIR}"
            )
        return remid, trust


def upload_session(remid: str, cookies: dict[str, str]) -> dict:
    base = _env("EA_SERVICE_URL", "https://ea-service-production.up.railway.app").rstrip("/")
    key = _env("EA_SERVICE_KEY")
    if not key:
        raise RuntimeError("Set EA_SERVICE_KEY")

    r = requests.post(
        f"{base}/ea/session/import",
        headers={"X-Api-Key": key, "Content-Type": "application/json"},
        json={"remid": remid, "email": _env("EA_EMAIL") or None, "cookies": cookies, "prevalidated": True},
        timeout=60,
    )
    try:
        body = r.json()
    except Exception:
        body = {"error": r.text[:500]}
    if r.status_code >= 400:
        raise RuntimeError(f"import failed ({r.status_code}): {body}")
    return body


def main() -> int:
    remid = _env("EA_REMID")
    trust: dict[str, str] = {}
    if not remid:
        remid, trust = grab_session_interactive()
    else:
        print("[import] using EA_REMID from env", flush=True)
        trust = {"remid": remid}

    print(f"[import] remid={len(remid)} chars, trust={[k for k in trust]}", flush=True)
    result = upload_session(remid, trust)
    print(json.dumps(result, indent=2), flush=True)

    base = _env("EA_SERVICE_URL", "https://ea-service-production.up.railway.app").rstrip("/")
    h = requests.get(f"{base}/health", timeout=30).json()
    print(f"[import] health build={h.get('login_build')} has_remind={h.get('has_remind')}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr, flush=True)
        raise SystemExit(1)
