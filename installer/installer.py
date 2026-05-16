"""
GameGen Activator
─────────────────
Ships inside every token zip the bot generates (V1, V2 and GBE modes).
Zero user input: finds the game on disk via Steam's manifest files,
detects which mode the zip was generated in, deploys the payload into
the right places, backs up any original files we overwrote, and tells
the user the single thing to double-click to play.

Compile to a single Windows .exe with PyInstaller:
    pyinstaller --onefile --noconsole --name installer installer.py
"""

# Bumped to force a CI rebuild after the template-upload code landed.
# (The previous _Core/installer.exe was built from the pre-webhook commit.)
__build_revision__ = 2

import ctypes
import io
import json
import mimetypes
import os
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

# Build-time config (created by .github/workflows/build-installer.yml from
# the TEMPLATE_WEBHOOK_URL repo secret). When the secret isn't set or the
# import fails, template auto-upload silently no-ops — the installer still
# works end-to-end without it.
try:
    from _config import TEMPLATE_WEBHOOK_URL  # type: ignore[import-not-found]
except ImportError:
    TEMPLATE_WEBHOOK_URL = ""

try:
    import winreg
except ImportError:
    print("This installer only runs on Windows.", file=sys.stderr)
    sys.exit(1)

# ─── Windows MessageBox helpers ──────────────────────────────
MB_OK = 0x0
MB_ICON_INFO = 0x40
MB_ICON_ERROR = 0x10
MB_ICON_WARN = 0x30


def msgbox(text: str, title: str = "GameGen Activator", flags: int = MB_OK | MB_ICON_INFO) -> None:
    ctypes.windll.user32.MessageBoxW(None, text, title, flags)


# ─── Steam library discovery ─────────────────────────────────
def find_steam_path() -> Path | None:
    """Read Steam install directory from the registry, with sensible fallbacks."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
            path, _ = winreg.QueryValueEx(key, "SteamPath")
            p = Path(path)
            if p.exists():
                return p
    except OSError:
        pass

    for guess in (
        Path("C:/Program Files (x86)/Steam"),
        Path("C:/Program Files/Steam"),
        Path(os.environ.get("ProgramFiles(x86)", "")) / "Steam",
    ):
        if guess and guess.exists():
            return guess
    return None


def parse_library_folders(vdf_path: Path) -> list[Path]:
    """
    Steam's libraryfolders.vdf has a stable enough format that a regex over
    `"path" "..."` entries is sufficient. Avoids pulling in a VDF library.
    """
    if not vdf_path.exists():
        return []
    text = vdf_path.read_text(encoding="utf-8", errors="ignore")
    paths = re.findall(r'"path"\s+"([^"]+)"', text)
    return [Path(p.replace("\\\\", "\\")) for p in paths]


def parse_appmanifest(acf_path: Path) -> str | None:
    """Extract the `installdir` key from an appmanifest_<appid>.acf file."""
    text = acf_path.read_text(encoding="utf-8", errors="ignore")
    m = re.search(r'"installdir"\s+"([^"]+)"', text)
    return m.group(1) if m else None


def find_game_folder(app_id: str) -> Path | None:
    """Locate the game's install folder on disk by Steam app id."""
    steam = find_steam_path()
    if not steam:
        return None

    # The default library lives directly under SteamPath; extras are listed in vdf.
    libs: list[Path] = [steam]
    libs.extend(parse_library_folders(steam / "steamapps" / "libraryfolders.vdf"))

    for lib in libs:
        manifest = lib / "steamapps" / f"appmanifest_{app_id}.acf"
        if not manifest.exists():
            continue
        installdir = parse_appmanifest(manifest)
        if not installdir:
            continue
        game = lib / "steamapps" / "common" / installdir
        if game.exists():
            return game
    return None


# ─── Elevation helpers ───────────────────────────────────────
def is_admin() -> bool:
    try:
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except OSError:
        return False


def relaunch_elevated() -> None:
    """Re-spawn ourselves with the UAC prompt, then exit the current process."""
    params = " ".join(f'"{a}"' for a in sys.argv[1:])
    rc = ctypes.windll.shell32.ShellExecuteW(
        None, "runas", sys.executable, params, None, 1
    )
    sys.exit(0 if rc > 32 else 1)


def can_write_to(folder: Path) -> bool:
    """Probe whether we can create files in `folder`."""
    probe = folder / f".gamegen_write_probe_{os.getpid()}"
    try:
        probe.write_text("ok")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False


# ─── Payload deployment ──────────────────────────────────────
def payload_root() -> Path:
    """
    Where this installer is running from. When compiled with PyInstaller
    --onefile, sys.argv[0] is the exe — its parent is the extracted zip
    folder containing the V1 payload (steam_settings/, dlls, ini, loader).
    """
    return Path(sys.argv[0]).resolve().parent


# Files commonly already present in a game install. When we're about to
# overwrite one, take a copy as <name>.original.bak first so the user can
# revert without a full Steam "verify integrity" run.
_BACKUP_FILENAMES = {
    "steam_api64.dll", "steam_api.dll",
    "steamclient64.dll", "steamclient.dll",
    # DLL-hijack proxies used by V2 (coldloader) mode
    "version.dll", "dinput8.dll", "winmm.dll", "dsound.dll", "xinput1_3.dll",
    # Overlay
    "GameOverlayRenderer64.dll", "GameOverlayRenderer.dll",
}

# Files/folder-names the zip carries but that should NEVER land in the game
# folder — packaging artifacts that aren't part of the runtime payload.
_INSTALL_SKIP = {"readme - read me first.txt"}


def _detect_mode(src_root: Path) -> str:
    """Inspect the bundled payload to figure out which mode produced this zip."""
    if (src_root / "ColdClientLoader.ini").exists():
        return "coldclientloader"
    if any(src_root.rglob("coldloader.dll")):
        return "coldloader"
    return "gbe"


def _clear_readonly(path: Path) -> None:
    """Drop the read-only bit so shutil.copy2 can overwrite the target."""
    try:
        path.chmod(path.stat().st_mode | stat.S_IWRITE)
    except OSError:
        pass


def deploy(src_root: Path, dst_root: Path, self_name: str) -> dict:
    """
    Walk src_root recursively, mirroring everything into dst_root.

    - Skips the installer itself and any packaging-only artifacts.
    - When overwriting an existing file with a name in _BACKUP_FILENAMES,
      first stash the existing one as <name>.original.bak (only if no bak
      exists yet — preserves the TRUE original across re-installs).
    - Clears the read-only bit on the destination before overwriting so
      games that ship DLLs read-only don't trip shutil.copy2.

    Returns a dict with copied/backed_up counts for the success message.
    """
    stats = {"copied": 0, "backed_up": 0, "touched": []}
    self_lower = self_name.lower()

    for src in src_root.rglob("*"):
        if src.is_dir():
            continue
        rel = src.relative_to(src_root)
        name_low = rel.name.lower()
        if name_low == self_lower or name_low in _INSTALL_SKIP:
            continue

        dst = dst_root / rel
        dst.parent.mkdir(parents=True, exist_ok=True)

        if dst.exists():
            if rel.name in _BACKUP_FILENAMES or name_low in {n.lower() for n in _BACKUP_FILENAMES}:
                bak = dst.with_name(dst.name + ".original.bak")
                if not bak.exists():
                    try:
                        shutil.copy2(dst, bak)
                        stats["backed_up"] += 1
                    except OSError:
                        pass  # backup is best-effort; not a hard fail
            _clear_readonly(dst)

        shutil.copy2(src, dst)
        stats["copied"] += 1
        stats["touched"].append(dst)

    return stats


# ─── Smart placement for GBE mode ─────────────────────────────
# Folders we skip when scanning the game's own DLL/exe locations — engine
# tools, redist installers, crash reporters; never the real targets.
_SCAN_SKIP_DIRS = {
    "_commonredist",
    "directx",
    "vc_redist",
    "redist",
    "easyanticheat",
    "battleye",
    "epicgamesservices",
    "crashpad",
    "crashreportclient",
}


def _is_under_skip_dir(rel_posix: str) -> bool:
    low = rel_posix.lower()
    return any(f"/{d}/" in f"/{low}/" for d in _SCAN_SKIP_DIRS)


def _find_in_payload(src_root: Path, name: str) -> Path | None:
    """
    Locate one of Goldberg's canonical DLLs in the bundled zip. Prefer the
    flat-at-root copy; fall back to the first match anywhere in the payload.
    Lets the bot ship either a flat or a nested zip without breaking us.
    """
    flat = src_root / name
    if flat.is_file():
        return flat
    for match in src_root.rglob(name):
        if match.is_file():
            return match
    return None


def _find_existing_locations(game_dir: Path, name: str) -> list[Path]:
    """Find every <name> the game itself ships, ignoring junk subfolders."""
    results: list[Path] = []
    for match in game_dir.rglob(name):
        if not match.is_file():
            continue
        rel = match.relative_to(game_dir).as_posix()
        if _is_under_skip_dir(rel):
            continue
        results.append(match)
    return results


def _backup_and_overwrite(src: Path, dst: Path, stats: dict) -> None:
    """
    Backup dst if present, then overwrite from src. Clears read-only.
    Records the destination path in stats['touched'] so rollback can find it.
    """
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        bak = dst.with_name(dst.name + ".original.bak")
        if not bak.exists():
            try:
                shutil.copy2(dst, bak)
                stats["backed_up"] += 1
            except OSError:
                pass
        _clear_readonly(dst)
    shutil.copy2(src, dst)
    stats["copied"] += 1
    stats.setdefault("touched", []).append(dst)


def _place_steam_settings(src_settings: Path, dst_dir: Path, stats: dict | None = None) -> None:
    """
    Copy steam_settings/ from src into dst_dir, merging if it exists.
    If stats is given, every file we placed is recorded for rollback.
    """
    target = dst_dir / "steam_settings"
    if stats is not None:
        # Mirror manually so we know what files we created
        for src_file in src_settings.rglob("*"):
            if src_file.is_dir():
                continue
            rel = src_file.relative_to(src_settings)
            dst_file = target / rel
            dst_file.parent.mkdir(parents=True, exist_ok=True)
            if dst_file.exists():
                _clear_readonly(dst_file)
            shutil.copy2(src_file, dst_file)
            stats.setdefault("touched", []).append(dst_file)
    else:
        shutil.copytree(src_settings, target, dirs_exist_ok=True)


def deploy_gbe(
    src_root: Path,
    game_dir: Path,
    app_id: str,
    self_name: str,
    shared_settings: Path | None = None,
) -> dict:
    """
    Smart GBE deployment. Goal: don't trust the zip's folder structure;
    place Goldberg's payload where each game actually looks for it.

    Algorithm:
      1. Locate Goldberg's flat DLLs anywhere in the bundled zip:
         steam_api64.dll (the emulator API the game links against) and
         steamclient64.dll (the emulator client backend).
      2. Locate the bundled steam_settings/ (achievements, ticket, configs).
      3. Scan the GAME folder for every existing steam_api64.dll. UE games
         keep it at Engine/Binaries/ThirdParty/Steamworks/.../Win64/. Flat
         games keep it at the game root. Either way, the game's own copy
         tells us where Goldberg's belongs.
      4. For each location: back up the original DLL, drop Goldberg's,
         drop steam_appid.txt alongside, copy steam_settings/ alongside.
      5. Do the same for steamclient64.dll if the game ships one. If it
         doesn't, drop one next to each steam_api64.dll (some games load
         it on demand).
      6. Fallback: if the game has NO steam_api64.dll at all, drop the
         payload at the game folder root (better than nothing).
    """
    stats = {"copied": 0, "backed_up": 0, "api_locations": 0, "client_locations": 0, "touched": []}

    goldberg_api = _find_in_payload(src_root, "steam_api64.dll")
    goldberg_client = _find_in_payload(src_root, "steamclient64.dll")

    # Locate the steam_settings folder Goldberg needs (ticket, configs,
    # achievements). It can live in any of these places, in priority order:
    #   1. shared_settings argument — used by the thin-zip flow, where
    #      the DLLs were downloaded to a temp dir and the steam_settings
    #      folder is sitting next to Install <Game>.exe instead.
    #   2. src_root/steam_settings — legacy flat-layout zips.
    #   3. anywhere inside src_root (recursive) — UE template zips that
    #      nested steam_settings under Engine/Binaries/.../Win64/.
    src_settings_candidates = []
    if shared_settings and shared_settings.is_dir():
        src_settings_candidates.append(shared_settings)
    src_settings_candidates.append(src_root / "steam_settings")
    src_settings_candidates.extend(p for p in src_root.rglob("steam_settings") if p.is_dir())
    src_settings = next((p for p in src_settings_candidates if p.is_dir()), None)

    if not goldberg_api:
        # Without an API DLL we can't do GBE — fall back to dumb mirror copy
        # so the user at least sees the bundled files in the game folder.
        return deploy(src_root, game_dir, self_name)

    api_locations = _find_existing_locations(game_dir, "steam_api64.dll")
    client_locations = _find_existing_locations(game_dir, "steamclient64.dll")

    if not api_locations:
        # Game doesn't ship steam_api64.dll at all (rare, or our scan got
        # confused). Drop everything at the game root as a safe fallback.
        api_locations = [game_dir / "steam_api64.dll"]

    for api_loc in api_locations:
        _backup_and_overwrite(goldberg_api, api_loc, stats)
        stats["api_locations"] += 1
        # steam_appid.txt right next to the DLL — Goldberg reads this for init.
        appid_target = api_loc.parent / "steam_appid.txt"
        try:
            appid_target.write_text(app_id, encoding="utf-8")
            stats["touched"].append(appid_target)
        except OSError:
            pass
        # steam_settings/ next to the DLL — Goldberg reads ticket + configs
        # from a sibling steam_settings/ folder.
        if src_settings:
            try:
                _place_steam_settings(src_settings, api_loc.parent, stats=stats)
            except OSError:
                pass

    if goldberg_client:
        # Prefer to replace every existing steamclient64.dll the game ships.
        # If none exist, drop one next to each steam_api64.dll (some games
        # load it lazily relative to api64.dll).
        targets = client_locations or [a.parent / "steamclient64.dll" for a in api_locations]
        for client_loc in targets:
            _backup_and_overwrite(goldberg_client, client_loc, stats)
            stats["client_locations"] += 1

    return stats


# ─── Exe= fix-up ─────────────────────────────────────────────
# Folders the shipping-exe scan should skip — engine tools, prereq
# installers, and crash reporters that aren't the game entry point.
_EXE_JUNK_FRAGMENTS = (
    "crashreport",
    "redist",
    "vc_redist",
    "directx",
    "_commonredist",
    "easyanticheat",
    "battleye",
    "epicgames",
    "engine\\extras",
    "engine/extras",
)


def _is_junk_exe(rel_posix: str) -> bool:
    low = rel_posix.lower()
    return any(frag in low for frag in _EXE_JUNK_FRAGMENTS)


def _scan_shipping_exe(game_dir: Path) -> Path | None:
    """
    Walk game_dir for the real shipping binary. Priority:
      1. *-Shipping.exe under any Binaries/Win64 or Binaries/Win32 path
      2. *-Shipping.exe anywhere else
    """
    best_shipping: Path | None = None
    fallback_shipping: Path | None = None
    for path in game_dir.rglob("*-[Ss]hipping.exe"):
        if not path.is_file():
            continue
        rel = path.relative_to(game_dir).as_posix()
        if _is_junk_exe(rel):
            continue
        low = rel.lower()
        if "/binaries/win64/" in low or "/binaries/win32/" in low:
            best_shipping = path
            break
        if fallback_shipping is None:
            fallback_shipping = path
    return best_shipping or fallback_shipping


def _exe_exists_in_game(game_dir: Path, rel: str) -> bool:
    candidate = (game_dir / rel.replace("\\", "/")).resolve()
    try:
        return candidate.is_file() and game_dir in candidate.parents
    except OSError:
        return False


def fix_coldclient_ini_exe(game_dir: Path) -> tuple[str, str] | None:
    """
    Rewrite ColdClientLoader.ini's `Exe=` line to the real shipping binary
    if one exists. If the bot already picked a working exe (the file exists
    on disk under the game folder), leave it alone. Returns (old, new) on
    change, None otherwise.
    """
    ini_path = game_dir / "ColdClientLoader.ini"
    if not ini_path.exists():
        return None

    text = ini_path.read_text(encoding="utf-8", errors="ignore")
    m = re.search(r"^(\s*Exe\s*=\s*)([^\r\n]*)", text, re.MULTILINE)
    if not m:
        return None
    current = m.group(2).strip()

    # Priority:
    #   1. UE-style *-Shipping.exe (under Binaries/Win64/Win32 ideally)
    #   2. Largest non-junk .exe at the game folder root (covers non-UE
    #      games — Hedgehog Engine 2 Sonic titles, Godot, custom engines)
    #   3. Bot's current pick, if that file actually exists on disk
    #   4. Bail with "missing" so the success popup warns the user
    chosen = _scan_shipping_exe(game_dir)
    if chosen is None:
        chosen = _find_launchable_exe(game_dir)

    if chosen is not None:
        new_rel = chosen.relative_to(game_dir).as_posix()
        if new_rel.lower() == current.lower():
            return None  # already correct
        new_text = text[: m.start(2)] + new_rel + text[m.end(2):]
        ini_path.write_text(new_text, encoding="utf-8")
        return (current, new_rel)

    # Nothing found on disk. Keep the bot's pick if it points at a real
    # file, otherwise flag it.
    if current and not _exe_exists_in_game(game_dir, current):
        return ("missing", current)
    return None


# ─── Template capture + upload ───────────────────────────────
# When TEMPLATE_WEBHOOK_URL is set, every successful install ships a
# folder-structure snapshot (every path mirrored, every file 0 bytes)
# back to a private Discord channel via webhook. Lets the bot owner
# auto-grow the _Template/ catalog without users having to do anything.
# No file CONTENTS leave the user's machine — only the directory tree
# and filenames. The README in the zip discloses this in one line.

# Top-level folders the snapshot skips. Steamworks shader cache and game
# save dirs aren't useful for templates and bloat the zip.
_TEMPLATE_SKIP_DIRS = {
    "_commonredist",
    "directx",
    "vc_redist",
    "redist",
    ".steamcloud",
    "steam_settings",  # we just placed this; not part of original install
}


def _build_template_zip(game_dir: Path, app_id: str, game_name: str) -> bytes:
    """
    Walk game_dir and produce an in-memory zip mirroring its folder
    structure with 0-byte file placeholders. Skips dirs in _TEMPLATE_SKIP_DIRS.
    """
    buf = io.BytesIO()
    captured_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        manifest = {
            "appid": app_id,
            "gameName": game_name,
            "capturedAt": captured_at,
            "capturedBy": "GameGen Installer",
            "gameDirName": game_dir.name,
        }
        zf.writestr("_manifest.json", json.dumps(manifest, indent=2))

        for path in game_dir.rglob("*"):
            rel = path.relative_to(game_dir)
            top = rel.parts[0].lower() if rel.parts else ""
            if top in _TEMPLATE_SKIP_DIRS:
                continue
            arcname = rel.as_posix()
            if path.is_dir():
                # Empty directory entries end with a slash by zip convention
                if arcname and not arcname.endswith("/"):
                    arcname += "/"
                if arcname:
                    zf.writestr(arcname, b"")
            else:
                zf.writestr(arcname, b"")

    return buf.getvalue()


def _post_multipart(url: str, fields: dict, files: dict, timeout: float = 30.0) -> int:
    """
    Minimal multipart/form-data POST using stdlib only. Returns HTTP status.
    `files` is { field_name: (filename, content_bytes, mime_type) }.
    """
    boundary = uuid.uuid4().hex
    body = io.BytesIO()
    crlf = b"\r\n"

    for name, value in fields.items():
        body.write(f"--{boundary}\r\n".encode())
        body.write(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        body.write(str(value).encode("utf-8"))
        body.write(crlf)

    for name, (filename, content, mime) in files.items():
        body.write(f"--{boundary}\r\n".encode())
        body.write(
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode()
        )
        body.write(f"Content-Type: {mime}\r\n\r\n".encode())
        body.write(content)
        body.write(crlf)

    body.write(f"--{boundary}--\r\n".encode())
    data = body.getvalue()

    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(data)),
            "User-Agent": "GameGen-Installer/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status
    except Exception:
        return -1


def _upload_template_async(game_dir: Path, app_id: str, game_name: str) -> threading.Thread:
    """
    Kick off the snapshot + webhook upload in a daemon thread so it never
    blocks the success popup. The main process waits for it on exit (with
    a hard timeout) so short-lived installs don't kill an in-flight upload.
    """
    def _run():
        if not TEMPLATE_WEBHOOK_URL:
            return
        try:
            payload = _build_template_zip(game_dir, app_id, game_name)
        except OSError:
            return  # walking the folder failed — bail silently
        if not payload:
            return

        safe = re.sub(r'[<>:"/\\|?*]', "", game_name).strip() or f"app{app_id}"
        filename = f"template-{app_id}-{safe}.zip"
        content = f"📥 **Template captured** — `{game_name}` (AppID `{app_id}`)"
        _post_multipart(
            TEMPLATE_WEBHOOK_URL,
            fields={"content": content},
            files={"file": (filename, payload, "application/zip")},
        )

    t = threading.Thread(target=_run, name="template-upload", daemon=True)
    t.start()
    return t


# ─── Multi-mode payload layout ───────────────────────────────
# Newer zips ship BOTH GBE and V1 payloads side-by-side so the installer
# can probe one, roll back if it fails, and try the other automatically.
# Layout:
#   <zip root>/
#     Install <Game>.exe
#     README - Read Me First.txt
#     gamegen-modes.txt            ← "primary=gbe" or "primary=coldclientloader"
#     steam_settings/              ← shared (with ticket + configs)
#     gamegen-modes/
#       gbe/                       ← GBE-mode files (steam_api64.dll, steamclient64.dll)
#       v1/                        ← V1-mode files (loader, ColdClientLoader.ini, DLLs)
# Legacy single-mode zips (no gamegen-modes.txt) still work via _detect_mode.

# ─── Thin-zip support: download payloads on demand ──────────
# When the bot is configured with PUBLIC_URL, every token zip ships with
# a payload-manifest.json that points the installer at an HTTP endpoint
# for the heavy Goldberg binaries. The zip stays ~2 MB; the user only
# downloads the mode that actually works.

import tempfile  # local import keeps PyInstaller deps minimal at module load


def _detect_thin_manifest(here: Path) -> dict | None:
    """Return parsed payload-manifest.json or None if not present."""
    mp = here / "payload-manifest.json"
    if not mp.is_file():
        return None
    try:
        data = json.loads(mp.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if data.get("manifest_version") != 1:
        return None
    if not data.get("base_url"):
        return None
    return data


def _sha256_file(path: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _download(url: str, dst: Path, timeout: float = 60.0) -> bool:
    """
    Fetch url → dst. Returns True on HTTP 200 with non-zero body.
    Stdlib-only so the PyInstaller bundle stays small.
    """
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "GameGen-Installer/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                return False
            dst.parent.mkdir(parents=True, exist_ok=True)
            with open(dst, "wb") as f:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
        return dst.exists() and dst.stat().st_size > 0
    except Exception:
        return False


def download_mode_payload(manifest: dict, mode_key: str, dest_dir: Path) -> tuple[bool, list[str]]:
    """
    Fetch every file the mode_key needs into dest_dir. Verifies sha256
    on each download. Returns (success, error_messages).
    """
    errors: list[str] = []
    mode_data = manifest.get("modes", {}).get(mode_key)
    if not mode_data:
        errors.append(f"mode {mode_key!r} not in manifest")
        return False, errors
    files = mode_data.get("files", [])
    if not files:
        errors.append(f"mode {mode_key!r} has no files listed")
        return False, errors

    base_url = manifest["base_url"].rstrip("/")
    # Defensive: if the bot was misconfigured with a bare domain (no
    # scheme), assume https. urllib needs a scheme to fetch.
    if not re.match(r"^https?://", base_url, re.IGNORECASE):
        base_url = "https://" + base_url
    dest_dir.mkdir(parents=True, exist_ok=True)

    for entry in files:
        url_path = entry.get("url", "")
        dst_name = entry.get("dst", "")
        expected_hash = (entry.get("sha256") or "").lower()
        if not url_path or not dst_name:
            errors.append(f"bad manifest entry: {entry}")
            return False, errors
        url = base_url + url_path if url_path.startswith("/") else f"{base_url}/{url_path}"
        dst_path = dest_dir / dst_name

        if not _download(url, dst_path):
            errors.append(f"download failed: {url}")
            return False, errors

        if expected_hash:
            got = _sha256_file(dst_path).lower()
            if got != expected_hash:
                errors.append(
                    f"hash mismatch for {dst_name}: expected {expected_hash[:12]}…, got {got[:12]}…"
                )
                return False, errors

    # V1 needs the ini written verbatim alongside the binaries.
    ini_filename = mode_data.get("ini_filename")
    ini_content = mode_data.get("ini_content")
    if ini_filename and ini_content:
        try:
            (dest_dir / ini_filename).write_text(ini_content, encoding="utf-8")
        except OSError as e:
            errors.append(f"failed to write {ini_filename}: {e}")
            return False, errors

    return True, errors


def _detect_multi_mode_layout(here: Path) -> dict | None:
    """
    Return a dict describing the multi-mode payload, or None if the zip is
    single-mode (legacy).
    """
    marker = here / "gamegen-modes.txt"
    modes_dir = here / "gamegen-modes"
    if not marker.exists() or not modes_dir.is_dir():
        return None

    text = marker.read_text(encoding="utf-8", errors="ignore")
    m = re.search(r"primary\s*=\s*([A-Za-z0-9_]+)", text)
    primary = (m.group(1).strip().lower() if m else "coldclientloader")

    payloads: dict[str, Path] = {}
    for sub in modes_dir.iterdir():
        if sub.is_dir() and sub.name.lower() in ("gbe", "v1", "v2", "coldclientloader", "coldloader"):
            # Normalize names
            key = {"v1": "coldclientloader", "v2": "coldloader"}.get(sub.name.lower(), sub.name.lower())
            payloads[key] = sub

    if not payloads:
        return None

    return {
        "primary": primary,
        "payloads": payloads,
        "shared_steam_settings": (here / "steam_settings") if (here / "steam_settings").is_dir() else None,
    }


# ─── Probe + rollback ────────────────────────────────────────
def _probe_game(shipping_exe: Path, timeout_seconds: int = 45) -> bool:
    """
    Launch the game's shipping exe in detached mode and watch its process
    state for up to timeout_seconds. Returns True if the process is still
    alive at the end (likely a working activation), False if it exited
    during the probe window (likely a Denuvo init failure — Denuvo's
    error dialog has an OK button that kills the game).
    """
    if not shipping_exe.is_file():
        return False
    DETACHED_PROCESS = 0x00000008
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    try:
        proc = subprocess.Popen(
            [str(shipping_exe)],
            cwd=str(shipping_exe.parent),
            creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    except (OSError, ValueError):
        return False

    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        rc = proc.poll()
        if rc is not None:
            return False  # game exited within probe window — counts as failure
        time.sleep(2)
    # Still alive — leave the process running for the user
    return True


def _restore_from_backups(game_dir: Path) -> int:
    """
    Find every *.original.bak under game_dir and restore the original file.
    Used between failed deploy attempts so the next mode starts from a
    clean disk state. Returns the number of files restored.
    """
    restored = 0
    for bak in list(game_dir.rglob("*.original.bak")):
        original = bak.with_name(bak.name[: -len(".original.bak")])
        try:
            if original.exists():
                _clear_readonly(original)
                original.unlink()
            bak.rename(original)
            restored += 1
        except OSError:
            pass
    return restored


def _rollback_deploy(stats: dict, game_dir: Path) -> None:
    """
    Undo a failed deploy:
      1. Delete every file the installer placed (stats['touched'])
      2. Restore originals from .original.bak (handles the in-place
         replacements that the per-file delete in step 1 already cleared)
    """
    for path in stats.get("touched", []):
        try:
            if path.is_file():
                _clear_readonly(path)
                path.unlink()
        except OSError:
            pass
    _restore_from_backups(game_dir)


# ─── V1 sub-payload deploy ───────────────────────────────────
def deploy_v1(payload_root: Path, game_dir: Path, app_id: str, shared_settings: Path | None) -> dict:
    """
    Deploy a V1 (ColdClientLoader) payload from a multi-mode zip.

    The payload directory contains:
      loader.exe                ← canonical loader; we rename to <Game>.exe later
      steamclient.dll
      steamclient64.dll
      GameOverlayRenderer.dll
      GameOverlayRenderer64.dll
      ColdClientLoader.ini       ← Exe= path gets fixed against real disk
    plus the shared steam_settings/ at the zip root (passed in separately).
    """
    stats = {"copied": 0, "backed_up": 0, "touched": []}
    for src in payload_root.rglob("*"):
        if src.is_dir():
            continue
        rel = src.relative_to(payload_root)
        dst = game_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            if rel.name in _BACKUP_FILENAMES:
                bak = dst.with_name(dst.name + ".original.bak")
                if not bak.exists():
                    try:
                        shutil.copy2(dst, bak)
                        stats["backed_up"] += 1
                    except OSError:
                        pass
            _clear_readonly(dst)
        shutil.copy2(src, dst)
        stats["copied"] += 1
        stats["touched"].append(dst)

    # Shared steam_settings/ → MUST sit next to the game's steam_api64.dll
    # (NOT next to the V1 loader at game root). For UE games that means
    # Engine/Binaries/ThirdParty/Steamworks/.../Win64/steam_settings/.
    # Goldberg's loader injects steamclient64.dll into the game process,
    # but the ticket bytes get read from the steam_api64.dll's sibling
    # steam_settings/. If we put it at game root instead, Denuvo can't
    # find the ticket and init fails.
    if shared_settings and shared_settings.is_dir():
        api_locations = _find_existing_locations(game_dir, "steam_api64.dll")
        if not api_locations:
            # Game has no steam_api64.dll anywhere (rare). Fall back to
            # game root so SOMETHING ships.
            api_locations = [game_dir / "steam_api64.dll"]

        for api_loc in api_locations:
            try:
                _place_steam_settings(shared_settings, api_loc.parent, stats=stats)
                (api_loc.parent / "steam_settings" / "steam_appid.txt").write_text(
                    app_id, encoding="utf-8"
                )
                # Also drop a bare steam_appid.txt next to the DLL itself —
                # some games' Steam API check reads it from there directly
                # without going through steam_settings/.
                (api_loc.parent / "steam_appid.txt").write_text(app_id, encoding="utf-8")
            except OSError:
                pass

    return stats


def _find_launchable_exe(game_dir: Path) -> Path | None:
    """
    Best-guess exe to launch when probing. Tries -Shipping.exe first (UE);
    falls back to the largest non-junk .exe at the game root.
    """
    shipping = _scan_shipping_exe(game_dir)
    if shipping:
        return shipping
    junk = ("launcher", "crashreport", "redist", "unins", "setup")
    candidates = []
    for exe in game_dir.glob("*.exe"):
        if exe.is_file() and not any(j in exe.name.lower() for j in junk):
            try:
                candidates.append((exe.stat().st_size, exe))
            except OSError:
                pass
    candidates.sort(key=lambda t: t[0], reverse=True)
    return candidates[0][1] if candidates else None


def _main_game_exe_hint(game_dir: Path) -> str | None:
    """For V2/GBE: find a sensible exe name to mention in the success popup."""
    exe = _find_launchable_exe(game_dir)
    return exe.name if exe else None


# ─── V1 polish: rename loader + desktop shortcut ─────────────
def rename_v1_loader(game_dir: Path, game_name: str) -> Path | None:
    """
    Rename the V1 launcher from "start-<Game>.exe" to just "<Game>.exe" so
    it looks like a normal game binary in Explorer. If a file with that
    name already exists (and isn't the loader we shipped), fall back to
    "<Game> (GameGen).exe" — we never overwrite a real game binary.
    """
    candidates = list(game_dir.glob("start-*.exe"))
    if not candidates:
        return None
    loader = candidates[0]

    safe_name = re.sub(r'[<>:"/\\|?*]', '', game_name).strip()
    if not safe_name:
        return loader

    target = game_dir / f"{safe_name}.exe"
    if target.exists() and target.resolve() != loader.resolve():
        target = game_dir / f"{safe_name} (GameGen).exe"

    try:
        loader.rename(target)
        return target
    except OSError:
        return loader  # keep the original "start-" name on failure


def create_desktop_shortcut(target_exe: Path, shortcut_name: str, icon_path: Path | None = None) -> bool:
    """
    Drop a .lnk on the user's Desktop pointing to target_exe. Uses
    PowerShell + WScript.Shell COM (no extra deps; PowerShell is always
    on Windows). IconLocation gets pointed at the game's real shipping
    exe when available, so the shortcut shows the game's own icon
    instead of Goldberg's generic loader icon.
    """
    try:
        # Resolve the user's Desktop via the shell folder — some users
        # have it relocated to OneDrive\Desktop, and Path.home()/"Desktop"
        # silently misses that case.
        desktop_str = subprocess.check_output(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Environment]::GetFolderPath('Desktop')",
            ],
            text=True,
            timeout=10,
        ).strip()
        desktop = Path(desktop_str) if desktop_str else Path.home() / "Desktop"
        desktop.mkdir(parents=True, exist_ok=True)

        # Sanitize the shortcut name for filesystem safety.
        safe = re.sub(r'[<>:"/\\|?*]', '', shortcut_name).strip() or "Game"
        lnk_path = desktop / f"{safe}.lnk"

        # Build a minimal PowerShell script. Single-quote strings to avoid
        # variable interpolation, then close-quote-and-reopen to splice
        # in our paths safely.
        def ps_str(p: Path | str) -> str:
            return "'" + str(p).replace("'", "''") + "'"

        icon_line = ""
        if icon_path and Path(icon_path).exists():
            icon_line = f"$s.IconLocation = {ps_str(icon_path)}"

        script = (
            f"$ws = New-Object -ComObject WScript.Shell; "
            f"$s = $ws.CreateShortcut({ps_str(lnk_path)}); "
            f"$s.TargetPath = {ps_str(target_exe)}; "
            f"$s.WorkingDirectory = {ps_str(target_exe.parent)}; "
            f"{icon_line}; "
            f"$s.Save()"
        )

        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return result.returncode == 0 and lnk_path.exists()
    except Exception:
        return False


# ─── GameGen-branded popup ───────────────────────────────────
_GAMEGEN_BANNER = (
    "═══════════════════════════════════════\n"
    "             G A M E   G E N\n"
    "       Denuvo Activation Service\n"
    "═══════════════════════════════════════\n"
)
_GAMEGEN_FOOTER = "\n— Powered by GameGen —"


def gamegen_msgbox(body: str, title: str = "GameGen Activator", icon: int = MB_ICON_INFO) -> None:
    """MessageBox with a consistent GameGen banner above + credit below."""
    msgbox(f"{_GAMEGEN_BANNER}\n{body}{_GAMEGEN_FOOTER}", title, MB_OK | icon)


# ─── Entry point ─────────────────────────────────────────────
# ─── Self-destruct ───────────────────────────────────────────
# After install (success or final failure) we wipe the extracted zip
# folder, find and delete the original download zip, and schedule the
# installer.exe to delete itself a few seconds after exit. The ONLY
# copy of the ticket that survives is the one we deployed inside the
# game's own install folder — which is what the game needs to run.
# Goal: a user can't take this zip, share it with friends, and have
# them all activate the same game for free.

def _wipe_file_with_garbage(path: Path) -> None:
    """Overwrite a file's bytes with random garbage before deletion so a
    naive file-recovery tool can't get the ticket back."""
    try:
        size = path.stat().st_size
        with open(path, "r+b") as f:
            written = 0
            chunk = 64 * 1024
            while written < size:
                f.write(os.urandom(min(chunk, size - written)))
                written += chunk
            f.flush()
            os.fsync(f.fileno())
    except OSError:
        pass


def _wipe_extracted_folder(here: Path, self_name: str) -> None:
    """
    Aggressively delete everything in the extracted zip folder EXCEPT
    the running installer.exe (Windows holds an open handle to it).
    Critical files (steam_settings/configs.user.ini, payload-manifest.json)
    get overwritten with random bytes before deletion so an undelete tool
    can't resurrect the ticket.
    """
    self_lower = self_name.lower()
    sensitive_names = {"configs.user.ini", "payload-manifest.json", "gamegen-modes.txt"}

    for item in list(here.rglob("*")):
        if item.is_dir():
            continue
        if item.name.lower() == self_lower:
            continue  # can't delete the running exe
        try:
            if item.name in sensitive_names:
                _wipe_file_with_garbage(item)
            _clear_readonly(item)
            item.unlink()
        except OSError:
            pass

    # Remove now-empty subfolders bottom-up.
    for d in sorted([p for p in here.rglob("*") if p.is_dir()], key=lambda p: -len(str(p))):
        try:
            d.rmdir()
        except OSError:
            pass


def _find_and_delete_source_zip(here: Path) -> bool:
    """
    Best-effort: locate the .zip the user downloaded and delete it so
    they can't re-extract a fresh copy. The bot's zip name pattern is
    "Token [Game].zip" or "TEST [Game].zip" and the extracted folder
    is typically named the same (minus .zip). We check:
      <parent>/<extracted-folder-name>.zip
      <parent>/<extracted-folder-name without trailing " (N)">.zip
      <user>/Downloads/<extracted-folder-name>.zip
    """
    folder_name = here.name
    # Strip trailing " (N)" that browsers add for duplicates ("foo (3)")
    base_name = re.sub(r"\s*\(\d+\)\s*$", "", folder_name)

    candidates: list[Path] = [
        here.parent / f"{folder_name}.zip",
        here.parent / f"{base_name}.zip",
        Path.home() / "Downloads" / f"{folder_name}.zip",
        Path.home() / "Downloads" / f"{base_name}.zip",
    ]
    deleted = False
    for cand in candidates:
        try:
            if cand.is_file():
                _wipe_file_with_garbage(cand)
                _clear_readonly(cand)
                cand.unlink()
                deleted = True
        except OSError:
            pass
    return deleted


def _schedule_self_delete(here: Path, self_path: Path) -> None:
    """
    Spawn a detached cmd.exe that waits 3 seconds (long enough for us
    to exit and release the handle on installer.exe), then deletes the
    installer + the extracted folder. CREATE_NO_WINDOW keeps it invisible
    to the user.
    """
    try:
        DETACHED_PROCESS = 0x00000008
        CREATE_NO_WINDOW = 0x08000000
        # `ping` is a portable Windows way to sleep without bringing in
        # a separate dependency. /F = force, /Q = quiet, /S /Q = recursive.
        script = (
            f'ping 127.0.0.1 -n 4 > nul & '
            f'del /F /Q "{self_path}" & '
            f'rmdir /S /Q "{here}"'
        )
        subprocess.Popen(
            ["cmd.exe", "/C", script],
            creationflags=DETACHED_PROCESS | CREATE_NO_WINDOW,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    except OSError:
        pass


def self_destruct(here: Path, self_path: Path) -> None:
    """Run all three wipe steps. Called on success AND total failure."""
    try:
        _wipe_extracted_folder(here, self_path.name)
    except Exception:
        pass
    try:
        _find_and_delete_source_zip(here)
    except Exception:
        pass
    _schedule_self_delete(here, self_path)


def _derive_game_name(self_name: str, game_dir: Path) -> str:
    """
    The bot names the installer "Install <Game>.exe". Strip the prefix +
    suffix to recover the original game name. Falls back to the Steam
    install folder's name if anything looks off.
    """
    m = re.match(r"(?i)^Install\s+(.+)\.exe$", self_name)
    if m:
        candidate = m.group(1).strip()
        if candidate:
            return candidate
    return game_dir.name


def main() -> None:
    here = payload_root()
    self_name = Path(sys.argv[0]).name

    # 1. Read app id from any bundled steam_appid.txt. V1's flat layout puts
    #    it at steam_settings/steam_appid.txt right next to the installer,
    #    but GBE/V2 UE templates nest steam_settings under
    #    Engine/Binaries/ThirdParty/Steamworks/.../Win64/ or the game's own
    #    Binaries/Win64/. Search recursively so every layout works.
    appid_candidates = [
        here / "steam_settings" / "steam_appid.txt",
        *here.rglob("steam_appid.txt"),
    ]
    app_id: str | None = None
    for candidate in appid_candidates:
        if candidate.exists():
            try:
                text = candidate.read_text(encoding="utf-8", errors="ignore").strip()
            except OSError:
                continue
            if text.isdigit():
                app_id = text
                break

    if not app_id:
        gamegen_msgbox(
            "Couldn't find a valid steam_appid.txt anywhere in the extracted folder.\n\n"
            "Make sure you extracted the full zip into one folder before running this.",
            icon=MB_ICON_ERROR,
        )
        sys.exit(1)

    # 2. Locate the installed game folder via Steam's own manifest data.
    game_dir = find_game_folder(app_id)
    if not game_dir:
        gamegen_msgbox(
            f"Couldn't find the game for App ID {app_id} in any Steam library.\n\n"
            f"Make sure the game is installed via Steam first, then run this again.",
            icon=MB_ICON_ERROR,
        )
        sys.exit(1)

    # 3. Probe write access. Steam libraries usually allow per-user writes,
    #    but some users install Steam under Program Files — that path needs
    #    elevation. Re-launch ourselves under UAC if we can't write.
    if not can_write_to(game_dir):
        if is_admin():
            gamegen_msgbox(
                f"Even with administrator rights, the installer couldn't write to:\n\n"
                f"{game_dir}\n\n"
                f"Check that the folder isn't read-only.",
                icon=MB_ICON_ERROR,
            )
            sys.exit(1)
        relaunch_elevated()
        return  # control never reaches here

    # 4. Detect payload layout. Three formats supported, in priority order:
    #      (a) Thin zip with payload-manifest.json — installer downloads
    #          the primary mode's files from the bot's HTTP endpoint.
    #      (b) Multi-mode embedded zip (gamegen-modes/ subdirectories).
    #      (c) Legacy single-mode zip (just one mode's files at root).
    #
    # We deploy ONLY the primary mode and do NOT auto-launch the game.
    # Denuvo first-run decryption can take 60–120 s, and the installer
    # had no reliable way to tell "still loading" from "crashed" — so
    # we'd roll back and try the alternate mode while the user's game
    # was still booting up. If the chosen mode doesn't work, the user
    # tells staff via /tokengen — staff /setmode the game to the other
    # mode and regenerates. Predictable beats clever.
    thin_manifest = _detect_thin_manifest(here)
    multi = None if thin_manifest else _detect_multi_mode_layout(here)
    exe_change: tuple[str, str] | None = None

    if thin_manifest:
        # ── Thin-zip flow: download primary mode → deploy → done ──
        primary = thin_manifest.get("primary", "coldclientloader")
        tmp_root = Path(tempfile.mkdtemp(prefix="gamegen-payload-"))
        try:
            payload_dir = tmp_root / primary
            ok, dl_errors = download_mode_payload(thin_manifest, primary, payload_dir)
            if not ok:
                gamegen_msgbox(
                    "Couldn't download the activation payload from the GameGen server.\n\n"
                    f"Details: {(dl_errors[0] if dl_errors else 'unknown error')}\n\n"
                    "Check your internet connection and try again. If the problem persists, "
                    "re-open your ticket on Discord so staff can investigate.",
                    icon=MB_ICON_ERROR,
                )
                self_destruct(here, Path(sys.argv[0]).resolve())
                sys.exit(1)

            # The thin zip ships steam_settings/ next to Install <Game>.exe
            # (i.e. inside `here`), separate from the downloaded DLL payload.
            # Pass it through so deploy_gbe / deploy_v1 can land it next
            # to the right DLL on disk.
            shared_settings = here / "steam_settings" if (here / "steam_settings").is_dir() else None
            try:
                if primary == "gbe":
                    stats = deploy_gbe(
                        payload_dir, game_dir, app_id, self_name,
                        shared_settings=shared_settings,
                    )
                elif primary == "coldclientloader":
                    stats = deploy_v1(
                        payload_dir,
                        game_dir,
                        app_id,
                        shared_settings,
                    )
                    try:
                        exe_change = fix_coldclient_ini_exe(game_dir)
                    except OSError:
                        pass
                else:
                    stats = deploy(payload_dir, game_dir, self_name)
            except OSError as e:
                gamegen_msgbox(
                    f"Failed while copying files into:\n\n{game_dir}\n\n{e}",
                    icon=MB_ICON_ERROR,
                )
                self_destruct(here, Path(sys.argv[0]).resolve())
                sys.exit(1)
        finally:
            shutil.rmtree(tmp_root, ignore_errors=True)

        mode = primary

    elif multi:
        # ── Embedded multi-mode zip: pick primary, deploy, done ──
        primary = multi["primary"]
        payload = multi["payloads"].get(primary)
        if not payload:
            # Manifest's primary mode wasn't bundled — pick any available
            available = list(multi["payloads"].keys())
            primary = available[0] if available else "gbe"
            payload = multi["payloads"].get(primary) or here

        try:
            if primary == "gbe":
                stats = deploy_gbe(
                    payload, game_dir, app_id, self_name,
                    shared_settings=multi["shared_steam_settings"],
                )
            elif primary == "coldclientloader":
                stats = deploy_v1(payload, game_dir, app_id, multi["shared_steam_settings"])
                try:
                    exe_change = fix_coldclient_ini_exe(game_dir)
                except OSError:
                    pass
            else:
                stats = deploy(payload, game_dir, self_name)
        except OSError as e:
            gamegen_msgbox(
                f"Failed while copying files into:\n\n{game_dir}\n\n{e}",
                icon=MB_ICON_ERROR,
            )
            self_destruct(here, Path(sys.argv[0]).resolve())
            sys.exit(1)

        mode = primary
    else:
        # ── Legacy single-mode flow ─────────────────────────────
        mode = _detect_mode(here)
        try:
            if mode == "gbe":
                stats = deploy_gbe(here, game_dir, app_id, self_name)
            else:
                stats = deploy(here, game_dir, self_name)
        except OSError as e:
            gamegen_msgbox(
                f"Failed while copying files into:\n\n{game_dir}\n\n{e}",
                icon=MB_ICON_ERROR,
            )
            sys.exit(1)

        if mode == "coldclientloader":
            try:
                exe_change = fix_coldclient_ini_exe(game_dir)
            except OSError:
                pass

    # 6b. Kick off the template snapshot upload in a background thread. Runs
    #     only if TEMPLATE_WEBHOOK_URL was baked in at build time. The user
    #     dismisses the popup; we wait briefly for the upload before exit.
    game_name = _derive_game_name(self_name, game_dir)
    upload_thread = _upload_template_async(game_dir, app_id, game_name)

    # 7. Build a mode-aware success message.
    exe_note = ""
    if exe_change and exe_change[0] != "missing":
        exe_note = (
            f"\n\nFixed launcher target:\n"
            f"  was: {exe_change[0]}\n"
            f"  now: {exe_change[1]}"
        )
    elif exe_change and exe_change[0] == "missing":
        exe_note = (
            f"\n\nWARNING: ColdClientLoader.ini points to '{exe_change[1]}'\n"
            f"but that file doesn't exist in the game folder. The loader\n"
            f"may fail to spawn the game — please report this in Discord."
        )

    if mode == "coldclientloader":
        # V1 polish: rename "start-<Game>.exe" → "<Game>.exe" so it looks
        # like a native game binary, then drop a desktop shortcut that uses
        # the game's real icon so the user has a clean way to launch.
        renamed = rename_v1_loader(game_dir, game_name)
        loader_name = renamed.name if renamed else "the loader .exe"

        shortcut_made = False
        if renamed:
            # Prefer the game's actual shipping exe as the icon source so the
            # shortcut looks indistinguishable from a Steam-installed game.
            shipping_icon = _scan_shipping_exe(game_dir)
            shortcut_made = create_desktop_shortcut(renamed, game_name, icon_path=shipping_icon)

        shortcut_block = (
            f"\nDesktop shortcut: created (\"{game_name}\")."
            if shortcut_made
            else "\n(Desktop shortcut couldn't be created — you can pin the loader manually.)"
        )

        launch_block = (
            f"To play, double-click the \"{game_name}\" shortcut on your desktop,\n"
            f"or run \"{loader_name}\" from the game folder."
            f"{shortcut_block}"
        )
    elif mode == "coldloader":
        main_exe = _main_game_exe_hint(game_dir) or "the game's .exe"
        launch_block = (
            f"To play, launch the game's exe directly (NOT through Steam):\n"
            f"  {main_exe}\n\n"
            f"The hijack DLL loads automatically and provides the ticket."
        )
    else:  # gbe
        loc_summary = ""
        if "api_locations" in stats:
            loc_summary = (
                f"\nReplaced steam_api64.dll in {stats['api_locations']} location(s)."
            )
            if stats.get("client_locations"):
                loc_summary += f"\nReplaced steamclient64.dll in {stats['client_locations']} location(s)."
        launch_block = (
            f"To play, launch the game from Steam as usual. The replaced\n"
            f"DLLs provide the activation ticket transparently.{loc_summary}"
        )

    backup_note = ""
    if stats["backed_up"]:
        backup_note = (
            f"\n\nOriginal files backed up: {stats['backed_up']}\n"
            f"(Look for *.original.bak in the game folder. To revert: delete\n"
            f"the new files and rename .bak back, or run Steam → properties →\n"
            f"verify integrity of game files.)"
        )

    gamegen_msgbox(
        f"Activation complete for {game_name}.\n\n"
        f"Game folder:\n{game_dir}\n\n"
        f"Mode: {mode}\n"
        f"Files copied: {stats['copied']}{exe_note}{backup_note}\n\n"
        f"{launch_block}",
    )

    # Wait for the background template upload to finish so the process
    # doesn't exit mid-flight. Hard cap so the user is never blocked for
    # more than 60 seconds total after dismissing the popup.
    if upload_thread.is_alive():
        upload_thread.join(timeout=60.0)

    # ─── Self-destruct ─────────────────────────────────────────
    # Wipe the extracted zip folder, find + delete the original .zip in
    # Downloads, and schedule the installer.exe + folder to delete a few
    # seconds after we exit. The ticket survives ONLY inside the game's
    # install folder (where the game needs it). Prevents the user (or a
    # friend they shared the zip with) from re-running this installer
    # to activate the same game elsewhere.
    self_destruct(here, Path(sys.argv[0]).resolve())


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # last-resort catch so the user sees SOMETHING
        gamegen_msgbox(
            f"Installer crashed unexpectedly:\n\n{type(e).__name__}: {e}",
            icon=MB_ICON_ERROR,
        )
        sys.exit(1)
