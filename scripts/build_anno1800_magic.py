#!/usr/bin/env python3
"""Build Anno 1800 Ubisoft magic-files zip (Bin/Win64 layout)."""

from __future__ import annotations

import json
import shutil
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAGIC_DIR = ROOT / "ubisoft-magic"
OUT_ZIP = MAGIC_DIR / "Anno 1800 Magic Files.zip"
BUILD_DIR = ROOT / "_build_anno1800"
BIN64 = BUILD_DIR / "Bin" / "Win64"

STEAM_APP_ID = 916440
GAME_ID = "d68d545a-defd-4a04-8566-880539285cb1"
USER_ID = "a4c21f90-6b3d-4e8a-9c1f-2d7e6f5a4b3c"

UBISOFT_DLCS = [
    4557, 12104, 14074, 16624, 17804, 60685, 14214, 14215, 14216, 5560,
    16621, 16622, 16623, 17316, 17627, 17795, 17794, 17796, 17797, 17798,
    17799, 5800, 60682, 60440, 60673, 60681, 60683, 60684, 5440, 5441,
    5442, 5443, 5444, 5445, 5446, 5447, 5448, 16625, 16626, 16627, 16628,
    16629, 16630, 17806, 17807, 17808, 17809, 17810, 17811, 60686, 60687,
    60688, 60689, 60690, 60691, 60692, 59721, 59720, 17029, 17030, 17031,
    17032, 17033, 4556,
]

STEAM_INTERFACES = (ROOT / "headless_token.py").read_text(encoding="utf-8").split(
    '_STEAM_INTERFACES_MODERN = """', 1
)[1].split('"""', 1)[0]


def fetch_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def write_upc_r2_ini(path: Path) -> None:
    lines = [
        "[Settings]",
        "Username = DenuvoVortex",
        "Email = goldberg@gmail.com",
        f"UserId = {USER_ID}",
        f"GameId = {GAME_ID}",
        "Language = en-US",
        "; avatar must be png for best results use 64x64, 128x128, 256x256",
        "Avatar = avatar.png",
        "",
        ";0 = appdata\\roaming\\Goldberg UplayEmu Saves",
        ";1 = SavePath in game folder",
        ";2 = Custom (SavePath)",
        "SaveType = 1",
        "SavePath = saves",
        "SaveExtension = .save",
        "",
        "[DLC]",
    ]
    lines.extend(str(d) for d in UBISOFT_DLCS)
    lines.extend(["", "[Items]", "", "[Chunks]", ""])
    path.write_text("\n".join(lines), encoding="utf-8")


def write_steam_settings(ss: Path) -> None:
    ss.mkdir(parents=True, exist_ok=True)
    (ss / "steam_appid.txt").write_text(str(STEAM_APP_ID), encoding="utf-8")

    (ss / "configs.user.ini").write_text(
        "\n".join(
            [
                "[user::general]",
                "account_name=AntiDenuvoSanctuary",
                "account_steamid=76561197960287930",
                "language=english",
            ]
        ),
        encoding="utf-8",
    )

    (ss / "configs.main.ini").write_text(
        "\n".join(
            [
                "[main::connectivity]",
                "disable_lan_only=1",
            ]
        ),
        encoding="utf-8",
    )

    (ss / "configs.overlay.ini").write_text(
        "\n".join(
            [
                "[overlay::general]",
                "enable_experimental_overlay=0",
                "",
                "[overlay::appearance]",
                "Font_Override=Roboto-Medium.ttf",
            ]
        ),
        encoding="utf-8",
    )

    dlc_lines = ["[app::dlcs]", "unlock_all=0"]
    try:
        details = fetch_json(
            f"https://store.steampowered.com/api/appdetails?appids={STEAM_APP_ID}&filters=basic"
        )
        data = details.get(str(STEAM_APP_ID), {}).get("data", {})
        for dlc_id in data.get("dlc") or []:
            dlc_lines.append(f"{int(dlc_id)}=")
    except Exception:
        pass
    (ss / "configs.app.ini").write_text("\n".join(dlc_lines) + "\n", encoding="utf-8")

    try:
        info = fetch_json(f"https://api.steamcmd.net/v1/info/{STEAM_APP_ID}")
        depots = info.get("data", {}).get(str(STEAM_APP_ID), {}).get("depots", {})
        depot_ids = [k for k in depots if str(k).isdigit()]
        if depot_ids:
            (ss / "depots.txt").write_text("\n".join(depot_ids), encoding="utf-8")
    except Exception:
        pass

    (ss / "supported_languages.txt").write_text(
        "\n".join(
            [
                "english",
                "french",
                "italian",
                "german",
                "spanish",
                "japanese",
                "koreana",
                "polish",
                "russian",
                "schinese",
                "tchinese",
            ]
        ),
        encoding="utf-8",
    )

    (ss / "steam_interfaces.txt").write_text(STEAM_INTERFACES, encoding="utf-8")

    # Achievements list only (no icon download) — enough for Goldberg init.
    try:
        schema = fetch_json(
            f"https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?appid={STEAM_APP_ID}"
        )
        achievements = []
        for ach in schema.get("game", {}).get("availableGameStats", {}).get("achievements", []):
            achievements.append(
                {
                    "name": ach.get("name", ""),
                    "displayName": ach.get("displayName", ""),
                    "description": ach.get("description", ""),
                    "hidden": int(bool(ach.get("hidden"))),
                    "icon": "",
                    "icongray": "",
                }
            )
        if achievements:
            (ss / "achievements.json").write_text(
                json.dumps(achievements, indent=2), encoding="utf-8"
            )
    except Exception:
        pass


def copy_shared_dlls() -> None:
    src_zip = MAGIC_DIR / "Assassin's Creed Shadows Magic Files.zip"
    with zipfile.ZipFile(src_zip) as zf:
        for name in (
            "dbdata.dll",
            "steam_api64.dll",
            "steamclient64.dll",
            "upc_r2_loader64.dll",
        ):
            zf.extract(name, BIN64)


def copy_optional_assets() -> None:
    anno117 = MAGIC_DIR / "ANNO 117 Magic Files.zip"
    with zipfile.ZipFile(anno117) as zf:
        for member in zf.namelist():
            if member.startswith("Bin/Win64/steam_settings/fonts/"):
                target = BUILD_DIR / member
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(zf.read(member))
            if member == "Bin/Win64/steam_settings/sounds/overlay_achievement_notification.wav":
                target = BUILD_DIR / member
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(zf.read(member))


def create_zip() -> None:
    if BUILD_DIR.exists():
        shutil.rmtree(BUILD_DIR)
    BIN64.mkdir(parents=True, exist_ok=True)

    copy_shared_dlls()
    write_upc_r2_ini(BIN64 / "upc_r2.ini")
    write_steam_settings(BIN64 / "steam_settings")
    copy_optional_assets()

    if OUT_ZIP.exists():
        OUT_ZIP.unlink()

    with zipfile.ZipFile(OUT_ZIP, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in BUILD_DIR.rglob("*"):
            if path.is_file():
                zf.write(path, path.relative_to(BUILD_DIR).as_posix())

    shutil.rmtree(BUILD_DIR)
    print(f"Created {OUT_ZIP} ({OUT_ZIP.stat().st_size} bytes)")


if __name__ == "__main__":
    create_zip()
