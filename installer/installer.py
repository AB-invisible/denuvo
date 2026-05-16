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
import sys
import threading
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
    stats = {"copied": 0, "backed_up": 0}
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

    shipping = _scan_shipping_exe(game_dir)
    if shipping is not None:
        new_rel = shipping.relative_to(game_dir).as_posix()
        if new_rel.lower() == current.lower():
            return None  # already correct
        new_text = text[: m.start(2)] + new_rel + text[m.end(2):]
        ini_path.write_text(new_text, encoding="utf-8")
        return (current, new_rel)

    # No shipping exe on disk — keep the bot's pick if it actually exists,
    # otherwise the loader will error and the user can report it.
    if current and not _exe_exists_in_game(game_dir, current):
        # bot's pick doesn't exist on disk and no shipping binary either — bail
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


def _main_game_exe_hint(game_dir: Path) -> str | None:
    """For V2/GBE: find a sensible exe name to mention in the success popup."""
    shipping = _scan_shipping_exe(game_dir)
    if shipping:
        return shipping.name
    # Fall back to any .exe at the game root that isn't an installer/launcher
    junk = ("launcher", "crashreport", "redist", "unins", "setup")
    for exe in sorted(game_dir.glob("*.exe"), key=lambda p: p.stat().st_size, reverse=True):
        low = exe.name.lower()
        if not any(j in low for j in junk):
            return exe.name
    return None


# ─── Entry point ─────────────────────────────────────────────
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
        msgbox(
            "Couldn't find a valid steam_appid.txt anywhere in the extracted folder.\n\n"
            "Make sure you extracted the full zip into one folder before running this.",
            flags=MB_OK | MB_ICON_ERROR,
        )
        sys.exit(1)

    # 2. Locate the installed game folder via Steam's own manifest data.
    game_dir = find_game_folder(app_id)
    if not game_dir:
        msgbox(
            f"Couldn't find the game for App ID {app_id} in any Steam library.\n\n"
            f"Make sure the game is installed via Steam first, then run this again.",
            flags=MB_OK | MB_ICON_ERROR,
        )
        sys.exit(1)

    # 3. Probe write access. Steam libraries usually allow per-user writes,
    #    but some users install Steam under Program Files — that path needs
    #    elevation. Re-launch ourselves under UAC if we can't write.
    if not can_write_to(game_dir):
        if is_admin():
            msgbox(
                f"Even with administrator rights, the installer couldn't write to:\n\n"
                f"{game_dir}\n\n"
                f"Check that the folder isn't read-only.",
                flags=MB_OK | MB_ICON_ERROR,
            )
            sys.exit(1)
        relaunch_elevated()
        return  # control never reaches here

    # 4. Detect the mode the zip was built in so we can give a mode-correct
    #    success message and decide what extra post-deploy steps to run.
    mode = _detect_mode(here)

    # 5. Copy the payload into the game folder, backing up any DLLs we're
    #    about to overwrite. shutil-level OSError is fatal here.
    try:
        stats = deploy(here, game_dir, self_name)
    except OSError as e:
        msgbox(
            f"Failed while copying files into:\n\n{game_dir}\n\n{e}",
            flags=MB_OK | MB_ICON_ERROR,
        )
        sys.exit(1)

    # 6. V1 only: fix ColdClientLoader.ini Exe= using the real shipping binary
    #    on disk (the bot's Steam-launch-config pick is sometimes stale).
    exe_change: tuple[str, str] | None = None
    if mode == "coldclientloader":
        try:
            exe_change = fix_coldclient_ini_exe(game_dir)
        except OSError:
            pass  # best-effort; the bot's pick may still work

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
        loaders = list(game_dir.glob("start-*.exe"))
        loader_name = loaders[0].name if loaders else "the loader .exe"
        launch_block = (
            f"To play, open the game folder and double-click:\n"
            f"  {loader_name}\n\n"
            f"Do NOT launch the game from Steam itself — always use the loader."
        )
    elif mode == "coldloader":
        main_exe = _main_game_exe_hint(game_dir) or "the game's .exe"
        launch_block = (
            f"To play, launch the game's exe directly (NOT through Steam):\n"
            f"  {main_exe}\n\n"
            f"The hijack DLL loads automatically and provides the ticket."
        )
    else:  # gbe
        launch_block = (
            "To play, launch the game from Steam as usual. The replaced\n"
            "DLLs provide the activation ticket transparently."
        )

    backup_note = ""
    if stats["backed_up"]:
        backup_note = (
            f"\n\nOriginal files backed up: {stats['backed_up']}\n"
            f"(Look for *.original.bak in the game folder. To revert: delete\n"
            f"the new files and rename .bak back, or run Steam → properties →\n"
            f"verify integrity of game files.)"
        )

    msgbox(
        f"Activation complete.\n\n"
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


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # last-resort catch so the user sees SOMETHING
        msgbox(
            f"Installer crashed unexpectedly:\n\n{type(e).__name__}: {e}",
            flags=MB_OK | MB_ICON_ERROR,
        )
        sys.exit(1)
