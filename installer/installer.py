"""
GameGen V1 Activator
────────────────────
Ships inside every V1 token zip. Zero user input: finds the game on
disk via Steam's manifest files, copies the V1 payload (loader, DLLs,
steam_settings/, ColdClientLoader.ini) into the game folder root, and
tells the user the single .exe to double-click to play.

Compile to a single Windows .exe with PyInstaller:
    pyinstaller --onefile --noconsole --name installer installer.py
"""

import ctypes
import os
import re
import shutil
import sys
from pathlib import Path

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


def deploy(src_root: Path, dst_root: Path, self_name: str) -> int:
    """
    Copy everything from src_root → dst_root, EXCEPT the installer itself.
    Returns the count of top-level items copied.
    """
    copied = 0
    for item in src_root.iterdir():
        if item.name.lower() == self_name.lower():
            continue
        target = dst_root / item.name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
        else:
            shutil.copy2(item, target)
        copied += 1
    return copied


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


# ─── Entry point ─────────────────────────────────────────────
def main() -> None:
    here = payload_root()
    self_name = Path(sys.argv[0]).name

    # 1. Read app id from the bundled steam_settings.
    appid_file = here / "steam_settings" / "steam_appid.txt"
    if not appid_file.exists():
        msgbox(
            "Couldn't find steam_settings\\steam_appid.txt next to the installer.\n\n"
            "Make sure you extracted the full zip into one folder before running this.",
            flags=MB_OK | MB_ICON_ERROR,
        )
        sys.exit(1)

    app_id = appid_file.read_text(encoding="utf-8", errors="ignore").strip()
    if not app_id.isdigit():
        msgbox(
            f"steam_appid.txt doesn't contain a valid Steam App ID (found: {app_id!r}).",
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

    # 4. Copy the payload into the game folder root.
    try:
        copied = deploy(here, game_dir, self_name)
    except OSError as e:
        msgbox(
            f"Failed while copying files into:\n\n{game_dir}\n\n{e}",
            flags=MB_OK | MB_ICON_ERROR,
        )
        sys.exit(1)

    # 5. Fix the ColdClientLoader.ini Exe= line. Steam's launch-config API
    #    sometimes lists a stale/launcher exe (e.g. "APK2.exe") that doesn't
    #    exist on disk, while the real binary is the UE shipping build at
    #    "UNION/Binaries/Win64/APK2-Win64-Shipping.exe". The bot can't see
    #    the user's disk; we can — so we rewrite the .ini using the real
    #    shipping binary if one exists.
    exe_change: tuple[str, str] | None = None
    try:
        exe_change = fix_coldclient_ini_exe(game_dir)
    except OSError:
        pass  # not fatal — loader may still work with the bot's pick

    # 6. Find the loader we just placed and report success.
    loaders = list(game_dir.glob("start-*.exe"))
    loader_name = loaders[0].name if loaders else "the loader .exe"

    exe_note = ""
    if exe_change and exe_change[0] != "missing":
        exe_note = (
            f"\n\nFixed launcher target:\n"
            f"  was: {exe_change[0]}\n"
            f"  now: {exe_change[1]}"
        )
    elif exe_change and exe_change[0] == "missing":
        # No shipping exe and the bot's pick doesn't exist on disk.
        # Don't fail — just warn. User can report and we'll patch the bot.
        exe_note = (
            f"\n\nWARNING: ColdClientLoader.ini points to '{exe_change[1]}'\n"
            f"but that file doesn't exist in the game folder. The loader\n"
            f"may fail to spawn the game — please report this in Discord."
        )

    msgbox(
        f"Activation complete.\n\n"
        f"Game folder:\n{game_dir}\n\n"
        f"Files copied: {copied}{exe_note}\n\n"
        f"To play, open the game folder and double-click:\n  {loader_name}\n\n"
        f"Tip: do NOT launch the game from Steam itself — always use the loader.",
    )


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
