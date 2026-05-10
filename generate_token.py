"""
generate_token.py — CLI entry point for automated token generation.
Called by the Discord bot's tokenGenerator.ts via child_process.

Usage: python generate_token.py <appId>

Outputs the zip file path on the last line of stdout on success.
"""
import sys, os

# Add the directory containing gamegen_core to the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# We need gamegen_core but it imports PySide6 — let's handle that
# by importing only the non-GUI parts we need
import json, shutil, base64, ctypes, time, re
import requests
from pathlib import Path


# ─── Inline core logic (no PySide6 dependency) ───
PROJECT_ROOT   = Path(__file__).resolve().parent
TICKETS_DIR    = PROJECT_ROOT / "Generated_Tokens"
CORE_DIR       = PROJECT_ROOT / "_Core"
COLDLOADER_SRC = CORE_DIR / "coldloader.dll"

def _find_dll(name):
    return CORE_DIR / name

STEAM_API_DLL   = _find_dll("steam_api64.dll")
OVERLAY_DLL     = _find_dll("GameOverlayRenderer64.dll")
VERSION_DLL     = _find_dll("version.dll")
STEAMCLIENT_DLL = _find_dll("steamclient64.dll")

for d in [TICKETS_DIR, CORE_DIR]:
    d.mkdir(exist_ok=True)


def find_steam_dll():
    p = CORE_DIR / "steam_api64.dll"
    return p if p.exists() else None


def fetch_app_info(app_id):
    try:
        r = requests.get(f"https://api.steamcmd.net/v1/info/{app_id}", timeout=8)
        return r.json().get("data", {}).get(str(app_id), {})
    except: return {}


def detect_exe_path(app_info):
    try:
        launch = app_info.get("config", {}).get("launch", {})
        for k, v in launch.items():
            exe = v.get("executable", "")
            if exe.endswith(".exe") and "win" in str(v.get("config", {}).get("oslist", "win")):
                return Path(exe)
    except: pass
    return None


def log(msg):
    print(msg, flush=True)


def generate_steam_settings(output_dir, app_id, steam_id=None):
    ss = output_dir / "steam_settings"
    ss.mkdir(parents=True, exist_ok=True)

    (output_dir / "steam_appid.txt").write_text(str(app_id))

    lines = ["[user::general]", "account_name=Game_Gen", "language=english"]
    if steam_id:
        lines.append(f"account_steamid={steam_id}")
    (ss / "configs.user.ini").write_text("\n".join(lines))

    (ss / "configs.overlay.ini").write_text("[overlay::general]\nenable_experimental_overlay = 1\n")
    (ss / "configs.main.ini").write_text("[main::connectivity]\ndisable_lan_only=1\n")

    ctrl = ss / "controller"
    ctrl.mkdir(exist_ok=True)
    (ctrl / "controls.txt").write_text(
        "AxisL=LJOY=joystick_move\nAxisR=RJOY=joystick_move\n"
        "AnalogL=LTRIGGER=trigger\nAnalogR=RTRIGGER=trigger\n")

    # DLCs
    try:
        r = requests.get(f"https://store.steampowered.com/api/dlcforapp/?appid={app_id}", timeout=5)
        dlc_data = r.json().get("applist", {}).get("apps", [])
        dlc_lines = ["[app::dlcs]", "unlock_all = 0"]
        for d in dlc_data:
            dlc_lines.append(f"{d['appid']}={d.get('name', 'DLC')}")
        (ss / "configs.app.ini").write_text("\n".join(dlc_lines))
    except:
        (ss / "configs.app.ini").write_text("[app::dlcs]\nunlock_all = 0\n")

    # Depots
    try:
        info = fetch_app_info(app_id)
        depots = info.get("depots", {})
        depot_ids = [k for k in depots if k.isdigit()]
        if depot_ids:
            (ss / "depots.txt").write_text("\n".join(depot_ids))
    except: pass

    (ss / "supported_languages.txt").write_text("english\njapanese\nbrazilian\nschinese\ntchinese\n")


def copy_coldloader_files(exe_dir):
    files = {
        "coldloader.dll": COLDLOADER_SRC,
        "GameOverlayRenderer64.dll": OVERLAY_DLL,
        "version.dll": VERSION_DLL,
        "steamclient64.dll": STEAMCLIENT_DLL,
    }
    for name, src in files.items():
        if src.exists():
            shutil.copy2(src, exe_dir / name)
            log(f"  Created {name}")
        else:
            log(f"  MISSING {name}")


def copy_goldberg_dlls(api_dir, exe_dir):
    for name, src in [
        ("steam_api64.dll", _find_dll("steam_api64.dll", _MKTL_API, CORE_DIR)),
        ("steamclient64.dll", _find_dll("steamclient64.dll", _MKTL_CL, CORE_DIR)),
    ]:
        if src.exists():
            target_dir = api_dir if name == "steam_api64.dll" else exe_dir
            shutil.copy2(src, target_dir / name)
            log(f"  Created {name}")


def get_ticket(app_id):
    """Generate encrypted app ticket via Steam API."""
    dll_path = find_steam_dll()
    if not dll_path:
        log("ERROR: steam_api64.dll not found")
        return None, None

    os.environ["SteamAppId"] = str(app_id)
    os.environ["SteamGameId"] = str(app_id)
    appid_file = dll_path.parent / "steam_appid.txt"
    appid_file.write_text(str(app_id))

    try:
        steam = ctypes.CDLL(str(dll_path))
    except Exception as e:
        log(f"ERROR: Failed to load DLL: {e}")
        return None, None

    try:
        # Init
        init_ok = False
        try:
            err_buf = ctypes.create_string_buffer(1024)
            fn = steam.SteamAPI_InitFlat
            fn.restype = ctypes.c_int
            fn.argtypes = [ctypes.c_char_p]
            init_ok = (fn(err_buf) == 0)
        except (AttributeError, OSError):
            pass
        if not init_ok:
            try:
                fn2 = steam.SteamAPI_Init
                fn2.restype = ctypes.c_bool
                fn2.argtypes = []
                init_ok = bool(fn2())
            except (AttributeError, OSError):
                pass
        if not init_ok:
            log("ERROR: Steam API init failed")
            return None, None

        log("Steam API initialized")

        # User
        ufn = steam.SteamAPI_SteamUser_v023
        ufn.restype = ctypes.c_void_p
        ufn.argtypes = []
        user = ufn()
        if not user:
            log("ERROR: No user interface")
            return None, None

        # Steam ID
        sid_fn = steam.SteamAPI_ISteamUser_GetSteamID
        sid_fn.restype = ctypes.c_uint64
        sid_fn.argtypes = [ctypes.c_void_p]
        steam_id = str(sid_fn(user))

        # Request ticket
        req = steam.SteamAPI_ISteamUser_RequestEncryptedAppTicket
        req.restype = ctypes.c_uint64
        req.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]
        req(user, None, 0)

        time.sleep(1.5)
        steam.SteamAPI_RunCallbacks()
        time.sleep(0.5)

        # Get ticket
        get = steam.SteamAPI_ISteamUser_GetEncryptedAppTicket
        get.restype = ctypes.c_bool
        get.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_uint32)]
        buf = (ctypes.c_ubyte * 4096)()
        sz = ctypes.c_uint32(0)
        if not get(user, buf, 4096, ctypes.byref(sz)):
            log("ERROR: GetEncryptedAppTicket failed — account may not own this game")
            return None, None

        token = base64.b64encode(bytes(buf[:sz.value])).decode()
        return token, steam_id

    except Exception as e:
        log(f"ERROR: {e}")
        return None, None
    finally:
        try: steam.SteamAPI_Shutdown()
        except: pass
        try: appid_file.unlink()
        except: pass
        os.environ.pop("SteamAppId", None)
        os.environ.pop("SteamGameId", None)


def main(app_id, game_name=None):
    app_id = str(app_id)
    out = TICKETS_DIR / app_id
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    # Fetch game name if not provided
    if not game_name:
        try:
            r = requests.get(f"https://store.steampowered.com/api/appdetails?appids={app_id}&filters=basic", timeout=5)
            d = r.json()
            if d and str(app_id) in d and d[str(app_id)]["success"]:
                game_name = d[str(app_id)]["data"]["name"]
        except: pass
    game_name = game_name or f"App {app_id}"

    log(f"Generating token for {game_name} ({app_id})...")

    # Detect exe path
    app_info = fetch_app_info(app_id)
    exe_rel = detect_exe_path(app_info)
    if exe_rel:
        exe_dir = out / exe_rel.parent
        api_dir = exe_dir
        log(f"Target: {exe_rel}")
    else:
        exe_dir = out
        api_dir = out
        log("Using root directory")

    exe_dir.mkdir(parents=True, exist_ok=True)
    ss_dir = api_dir / "steam_settings"
    ss_dir.mkdir(parents=True, exist_ok=True)

    # Get ticket
    token, steam_id = get_ticket(app_id)
    if token is None:
        log("FAILED")
        sys.exit(1)

    # Generate settings
    generate_steam_settings(api_dir, app_id, steam_id)
    log("Generated steam_settings")

    # Inject ticket
    cfg = ss_dir / "configs.user.ini"
    content = cfg.read_text() if cfg.exists() else "[user::general]\naccount_name=Game_Gen\nlanguage=english"
    if "ticket=" not in content:
        content += f"\nticket={token}"
    cfg.write_text(content)
    log("Injected ticket")

    # Copy coldloader + goldberg DLLs
    copy_coldloader_files(exe_dir)
    copy_goldberg_dlls(api_dir, exe_dir)

    # Zip with game name
    safe_name = re.sub(r'[<>:"/\\|?*]', '', game_name).strip()
    zip_base = str(TICKETS_DIR / f"Token [{safe_name}]")
    zip_path = shutil.make_archive(zip_base, 'zip', root_dir=str(out))
    log(f"Zipped: {zip_path}")

    # Clean temp folder
    shutil.rmtree(out, ignore_errors=True)

    # OUTPUT: last line = zip path (tokenGenerator.ts reads this)
    print(zip_path)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python generate_token.py <appId> [gameName]", file=sys.stderr)
        sys.exit(1)
    name = sys.argv[2] if len(sys.argv) > 2 else None
    main(sys.argv[1], name)
