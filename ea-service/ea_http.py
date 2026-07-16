"""Shared HTTP client for all EA traffic — Chrome TLS + optional residential proxy."""

from __future__ import annotations

import os

import requests


def proxy_url() -> str:
    return os.environ.get("EA_PROXY_URL", "").strip() or os.environ.get("HTTPS_PROXY", "").strip()


def http_session():
    """curl_cffi Chrome fingerprint; optional EA_PROXY_URL for residential IP."""
    proxies = None
    url = proxy_url()
    if url:
        proxies = {"http": url, "https": url}

    try:
        from curl_cffi import requests as curl_requests

        s = curl_requests.Session(impersonate="chrome131")
        if proxies:
            s.proxies = proxies
        return s
    except Exception:
        s = requests.Session()
        if proxies:
            s.proxies.update(proxies)
        return s
