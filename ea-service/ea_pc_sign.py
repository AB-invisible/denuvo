"""
Synthetic pc_sign + machine_hash generation for headless Linux/Railway.

Adapted from public EA Desktop pc_sign research (galaxy-integration-ead /
anadius token_generator set_remid_cookie). Uses a stable seed per account so
values persist across redeploys when stored in ea_session.json.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import random
import secrets
import string
from datetime import datetime, timezone
from typing import Literal

PC_SIGN_KEYS = {
    "v1": b"ISa3dpGOc8wW7Adn4auACSQmaccrOyR2",
    "v2": b"nt5FfJbdPzNcl2pkC3zgjO43Knvscxft",
}


def _seed_rng(seed: str) -> random.Random:
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def _ea_timestamp() -> str:
    now = datetime.now(timezone.utc)
    ms = now.microsecond // 1000
    return f"{now.year}-{now.month}-{now.day} {now.hour}:{now.minute}:{now.second}:{ms}"


def url_base64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def generate_machine_hash(seed: str) -> str:
    """
    Deterministic 40-char hex machine hash (SHA-1 style) from account seed.
    anadius token_generator's manual remid path uses randomly generated
    hardware-ish values; a stable synthetic profile works the same on Linux.
    """
    rng = _seed_rng(seed + "|machine")
    board = "Microsoft Corporation"
    bios = "American Megatrends Inc."
    volume = f"{rng.randint(0, 0xFFFFFFFF):08x}"
    gpu_dev = rng.randint(0x1000, 0x9FFF)
    gpu = f"PCI\\VEN_{rng.randint(0x10, 0x10DE):04X}&DEV_{gpu_dev:04X}&SUBSYS_{rng.randint(0, 0xFFFFFFFF):08X}&REV_{rng.randint(0, 255):02X}\\0DEADBEEF&0&DEAD"
    cpu_man = "GenuineIntel"
    cpu_edx_eax = f"{rng.randint(0, 0xFFFFFFFF):08X}{rng.randint(0, 0xFFFFFFFF):08X}"
    brand = "Intel(R) Core(TM) CPU"
    parts = [
        board,
        "None",
        bios,
        "None",
        volume,
        gpu,
        cpu_man,
        cpu_edx_eax,
        brand + ";",
    ]
    final_data = ";".join(parts)
    return hashlib.sha1(final_data.encode("utf-8")).hexdigest()


def _synthetic_pc_fields(seed: str) -> dict[str, object]:
    rng = _seed_rng(seed + "|pcsign")
    letters = string.ascii_lowercase
    digits = string.digits

    def rand_join(n: int, alphabet: str) -> str:
        return "".join(rng.choice(alphabet) for _ in range(n))

    mac = "$" + "".join(f"{rng.randint(0, 255):02x}" for _ in range(6))
    return {
        "av": "v1",
        "bsn": rand_join(rng.randint(8, 16), letters),
        "gid": rng.randint(0x1000, 0xFFFF),
        "hsn": rand_join(rng.randint(8, 16), letters + digits),
        "mac": mac,
        "mid": str(rng.randint(10**18, 10**19 - 1)),
        "msn": "." + rand_join(rng.randint(8, 12), letters.upper()) + "." + rand_join(6, digits),
        "sv": rng.choice(["v1", "v2"]),
    }


def generate_pc_sign(seed: str, sv: str | None = None) -> str:
    fields = _synthetic_pc_fields(seed)
    if sv:
        fields["sv"] = sv
    fields["ts"] = _ea_timestamp()
    payload_json = json.dumps(fields, separators=(",", ":"))
    payload_b64 = url_base64(payload_json.encode("utf-8"))
    key = PC_SIGN_KEYS.get(str(fields["sv"]), PC_SIGN_KEYS["v2"])
    sig = hmac.new(key, payload_b64.encode("ascii"), hashlib.sha256).digest()
    return f"{payload_b64}.{url_base64(sig)}"


def refresh_pc_sign(stored_signature: str, sv: str = "v2") -> str:
    """Refresh timestamp + HMAC on a stored pc_sign."""
    if "." not in stored_signature:
        return stored_signature
    payload_b64, _old_sig = stored_signature.split(".", 1)
    pad = "=" * (-len(payload_b64) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + pad).decode("utf-8"))
    except Exception:
        return stored_signature

    payload["ts"] = _ea_timestamp()
    payload["sv"] = sv
    new_payload_b64 = url_base64(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    key = PC_SIGN_KEYS.get(sv, PC_SIGN_KEYS["v2"])
    sig = hmac.new(key, new_payload_b64.encode("ascii"), hashlib.sha256).digest()
    return f"{new_payload_b64}.{url_base64(sig)}"


def random_cid() -> str:
    alphabet = string.ascii_letters + string.digits
    return f"{''.join(secrets.choice(alphabet) for _ in range(32))},{''.join(secrets.choice(alphabet) for _ in range(32))}"
