"""
Auto-read EA one-time login codes from Gmail — zero manual /eacode steps.

Set on Railway ea-service:
  EA_GMAIL_APP_PASSWORD=<16-char Google app password for pokemgo300@gmail.com>

Create at: Google Account → Security → 2-Step Verification → App passwords
"""

from __future__ import annotations

import email
import imaplib
import os
import re
import time
from email.header import decode_header
from typing import Optional

CODE_RE = re.compile(r"\b(\d{6})\b")
EA_FROM_RE = re.compile(r"(?i)(ea\.com|electronic.?arts|origin|noreply)")


def _env(key: str) -> str:
    return os.environ.get(key, "").strip()


def _decode_subject(msg: email.message.Message) -> str:
    raw = msg.get("Subject", "")
    parts = decode_header(raw)
    out = []
    for chunk, enc in parts:
        if isinstance(chunk, bytes):
            out.append(chunk.decode(enc or "utf-8", errors="replace"))
        else:
            out.append(str(chunk))
    return " ".join(out)


def _extract_code_from_message(msg: email.message.Message) -> Optional[str]:
    subject = _decode_subject(msg)
    for blob in (subject,):
        m = CODE_RE.search(blob)
        if m:
            return m.group(1)

    body_parts: list[str] = []
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() not in ("text/plain", "text/html"):
                continue
            try:
                payload = part.get_payload(decode=True)
                if payload:
                    body_parts.append(payload.decode(part.get_content_charset() or "utf-8", errors="replace"))
            except Exception:
                continue
    else:
        try:
            payload = msg.get_payload(decode=True)
            if payload:
                body_parts.append(payload.decode(msg.get_content_charset() or "utf-8", errors="replace"))
        except Exception:
            pass

    for text in body_parts:
        m = CODE_RE.search(text)
        if m:
            return m.group(1)
    return None


def wait_for_ea_login_code(
    account_email: Optional[str] = None,
    app_password: Optional[str] = None,
    timeout_sec: int = 180,
    poll_sec: int = 5,
) -> str:
    """
    Poll Gmail IMAP for the newest EA verification code.
    Only considers emails received after this function starts.
    """
    account_email = (account_email or _env("EA_EMAIL")).strip()
    app_password = app_password or _env("EA_GMAIL_APP_PASSWORD")
    if not account_email or not app_password:
        raise RuntimeError(
            "EA_GMAIL_APP_PASSWORD not set — create a Google App Password for the EA inbox "
            "and add it to Railway ea-service variables."
        )

    imap_host = _env("EA_IMAP_HOST") or "imap.gmail.com"
    started = time.time()
    deadline = started + timeout_sec
    seen_uids: set[bytes] = set()

    while time.time() < deadline:
        mail = imaplib.IMAP4_SSL(imap_host)
        try:
            mail.login(account_email, app_password)
            mail.select("INBOX")
            _, data = mail.search(None, "(UNSEEN)")
            uids = data[0].split() if data and data[0] else []
            for uid in reversed(uids):
                if uid in seen_uids:
                    continue
                seen_uids.add(uid)
                _, msg_data = mail.fetch(uid, "(RFC822)")
                if not msg_data or not msg_data[0]:
                    continue
                raw = msg_data[0][1]
                msg = email.message_from_bytes(raw)
                from_hdr = msg.get("From", "")
                if not EA_FROM_RE.search(from_hdr):
                    continue
                code = _extract_code_from_message(msg)
                if code:
                    print(f"[ea_imap] got EA code from {from_hdr[:60]}", flush=True)
                    return code
        finally:
            try:
                mail.logout()
            except Exception:
                pass
        time.sleep(poll_sec)

    raise TimeoutError(f"No EA verification email arrived within {timeout_sec}s — check spam or retry.")
