"""
headless_token.py — Headless Denuvo token generator.

Uses steampass.gg API to get Steam credentials + guard code,
then ValvePython's `steam` library to generate encrypted app tickets
without needing the Steam client installed.

Usage: python headless_token.py <appId> <gameName> <steampassUuid>

Environment variables:
  STEAMPASS_LOGIN    — steampass.gg login (username)
  STEAMPASS_PASSWORD — steampass.gg password

Outputs the zip file path on the last line of stdout on success.
"""
import sys, os, json, shutil, re, time, base64, struct
import requests
from pathlib import Path

# ─── CONFIG ───────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent
TEMPLATE_DIR = PROJECT_ROOT / "_Template"
TICKETS_DIR  = PROJECT_ROOT / "Generated_Tokens"
CORE_DIR     = PROJECT_ROOT / "_Core"

STEAMPASS_API = "https://steampass.gg/api"

for d in [TEMPLATE_DIR, TICKETS_DIR, CORE_DIR]:
    d.mkdir(exist_ok=True)


def log(msg):
    print(msg, flush=True)


# ─── TEMPLATE VALIDATION ─────────────────────────
def get_template_status(app_id):
    """Check if a template exists and looks valid."""
    tpl_dir = TEMPLATE_DIR / str(app_id)
    if not tpl_dir.exists():
        return "missing"
    has_appid = any(tpl_dir.rglob("steam_appid.txt"))
    if not has_appid:
        return "corrupt"
    has_settings = any(tpl_dir.rglob("steam_settings"))
    return "ok" if has_settings else "corrupt"


# ─── STEAMPASS API ────────────────────────────────
class SteampassClient:
    """HTTP client for steampass.gg API."""

    def __init__(self, login, password):
        self.login = login
        self.password = password
        self.token = None
        self.session = requests.Session()
        self.session.headers.update({
            "Accept": "application/json",
            "Content-Type": "application/json",
        })

    def authenticate(self):
        """Login to steampass.gg and get bearer token."""
        resp = self.session.post(f"{STEAMPASS_API}/auth/login", json={
            "login": self.login,
            "password": self.password,
        }, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        self.token = data.get("data", {}).get("token")
        if not self.token:
            raise RuntimeError(f"Steampass login failed: {data}")
        self.session.headers["Authorization"] = f"Bearer {self.token}"
        log("Steampass: authenticated")

    def get_steam_credentials(self, product_uuid):
        """Get Steam username + password for a product."""
        resp = self.session.get(
            f"{STEAMPASS_API}/profile/product-credentials/{product_uuid}",
            params={"account_platform": 1},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json().get("data", {})
        steam = data.get("steam", data)  # Handle both nested and flat responses
        login = steam.get("login")
        password = steam.get("password")
        guarded = steam.get("guarded", True)
        if not login or not password:
            raise RuntimeError(f"No Steam credentials returned for {product_uuid}")
        log(f"Steampass: got credentials (guarded={guarded})")
        return login, password, guarded

    def get_guard_code(self, product_uuid):
        """Request a Steam Guard authorization code."""
        resp = self.session.post(
            f"{STEAMPASS_API}/email/code/main",
            json={"uuid": product_uuid},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json().get("data", {})
        code = data.get("code")
        valid_until = data.get("valid_until")
        if not code:
            raise RuntimeError(f"No guard code returned for {product_uuid}")
        log(f"Steampass: guard code received (expires: {valid_until})")
        return code


# ─── HEADLESS STEAM TOKEN GENERATION ──────────────
def get_encrypted_ticket_headless(app_id, steam_login, steam_password, guard_code):
    """Connect to Steam CM servers headlessly and get an encrypted app ticket.
    
    Uses ValvePython's steam library — no Steam client needed.
    Tested and confirmed working with steampass.gg TOTP guard codes.
    """
    from steam.client import SteamClient
    from steam.enums import EResult

    app_id = int(app_id)
    client = SteamClient()

    # Connect to Steam CM servers (blocking call via gevent)
    log("Steam: connecting to CM servers...")
    client.connect()

    if not client.connected:
        raise RuntimeError("Steam: failed to connect to CM servers")
    log("Steam: connected!")

    # Login with credentials + guard code (TOTP-style from steampass.gg)
    log("Steam: authenticating...")
    result = client.login(
        username=steam_login,
        password=steam_password,
        two_factor_code=guard_code,
    )

    if result != EResult.OK:
        client.disconnect()
        raise RuntimeError(f"Steam: login failed with result: {result}")

    steam_id = str(client.steam_id.as_64)
    log(f"Steam: logged in (SteamID: {steam_id})")

    # Request encrypted app ticket
    log(f"Steam: requesting encrypted app ticket for AppID {app_id}...")
    try:
        resp = client.get_encrypted_app_ticket(app_id, userdata=b'')

        if not resp:
            client.logout()
            client.disconnect()
            raise RuntimeError(
                "Steam: no ticket returned (account may not own the game)")

        # The response is a protobuf CMsgClientRequestEncryptedAppTicketResponse
        # with a nested EncryptedAppTicket field — serialize it to get raw bytes
        ticket_obj = resp.encrypted_app_ticket
        if hasattr(ticket_obj, 'SerializeToString'):
            ticket_bytes = ticket_obj.SerializeToString()
        elif isinstance(ticket_obj, bytes):
            ticket_bytes = ticket_obj
        else:
            ticket_bytes = bytes(ticket_obj)

        if not ticket_bytes:
            client.logout()
            client.disconnect()
            raise RuntimeError("Steam: ticket was empty")

        log(f"Steam: ticket received ({len(ticket_bytes)} bytes)")

    except RuntimeError:
        raise
    except Exception as e:
        client.logout()
        client.disconnect()
        raise RuntimeError(f"Steam: ticket request failed: {e}")

    client.logout()
    client.disconnect()
    return ticket_bytes, steam_id


# ─── GOLDBERG SETTINGS GENERATOR ──────────────────
def generate_steam_settings(output_dir, app_id, steam_id=None):
    """Generate steam_settings folder for Goldberg emulator."""
    ss = output_dir / "steam_settings"
    ss.mkdir(parents=True, exist_ok=True)

    (output_dir / "steam_appid.txt").write_text(str(app_id))

    lines = ["[user::general]", "account_name=Game_Gen", "language=english"]
    if steam_id:
        lines.append(f"account_steamid={steam_id}")
    (ss / "configs.user.ini").write_text("\n".join(lines))

    (ss / "configs.overlay.ini").write_text(
        "[overlay::general]\nenable_experimental_overlay = 1\n")
    (ss / "configs.main.ini").write_text(
        "[main::connectivity]\ndisable_lan_only=1\n")

    # Controller — match the template controls.txt exactly
    ctrl = ss / "controller"
    ctrl.mkdir(exist_ok=True)
    (ctrl / "controls.txt").write_text(
        "AxisL=LJOY=joystick_move\n"
        "AxisR=RJOY=joystick_move\n"
        "AnalogL=LTRIGGER=trigger\n"
        "AnalogR=RTRIGGER=trigger\n"
        "LDown=DDOWN\n"
        "LLeft=DLEFT\n"
        "LRight=DRIGHT\n"
        "RRight=B\n"
        "CLeft=BACK\n"
        "CRight=START\n"
        "LStickPush=LSTICK\n"
        "RStickPush=RSTICK\n"
        "LTrigTop=LBUMPER\n"
        "RTrigTop=RBUMPER\n"
    )

    # DLCs — templates use plain "unlock_all = 0" without enumerating DLCs
    (ss / "configs.app.ini").write_text("[app::dlcs]\nunlock_all = 0")

    # Depots
    try:
        r = requests.get(
            f"https://api.steamcmd.net/v1/info/{app_id}", timeout=8)
        info = r.json().get("data", {}).get(str(app_id), {})
        depots = info.get("depots", {})
        depot_ids = [k for k in depots if k.isdigit()]
        if depot_ids:
            (ss / "depots.txt").write_text("\n".join(depot_ids))
    except:
        pass

    (ss / "supported_languages.txt").write_text(
        "english\njapanese\nbrazilian\nschinese\ntchinese\n")


def _get_all_launch_configs(app_id):
    """Get all Windows exe launch configs from SteamCMD API."""
    try:
        r = requests.get(
            f"https://api.steamcmd.net/v1/info/{app_id}", timeout=8)
        info = r.json().get("data", {}).get(str(app_id), {})
        launch = info.get("config", {}).get("launch", {})
        configs = []
        for k, v in launch.items():
            exe = v.get("executable", "")
            if exe.endswith(".exe") and "win" in str(
                    v.get("config", {}).get("oslist", "win")):
                configs.append(exe.lstrip("\\").replace("\\", "/"))
        return configs
    except:
        return []


def _detect_ue_structure(configs):
    """Detect UE folder structure. Returns (game_path, exe_dir) or None."""
    for exe_path in configs:
        parts = exe_path.split("/")
        for i, part in enumerate(parts):
            if part == "Binaries" and i + 1 < len(parts) and parts[i + 1] == "Win64":
                game_path = "/".join(parts[:i])
                if game_path:
                    return game_path, "/".join(parts[:-1])
    return None


def _detect_nested_exe(configs):
    """Detect nested exe dir, skipping artbook/launcher extras."""
    skip = ["ArtBook", "artbook", "Launcher", "2KLauncher", "book"]
    best = None
    for exe_path in configs:
        parts = exe_path.split("/")
        if len(parts) > 1:
            if any(s in exe_path for s in skip):
                if best is None:
                    best = "/".join(parts[:-1])
                continue
            return "/".join(parts[:-1])
    return best


# ─── DLL COPYING ──────────────────────────────────
def _find_dll(name):
    """Find a DLL in the _Core directory."""
    return CORE_DIR / name


def copy_coldloader_files(exe_dir):
    """Copy coldloader DLLs to exe directory."""
    files = {
        "coldloader.dll": _find_dll("coldloader.dll"),
        "GameOverlayRenderer64.dll": _find_dll("GameOverlayRenderer64.dll"),
        "version.dll": _find_dll("version.dll"),
        "steamclient64.dll": _find_dll("steamclient64.dll"),
    }
    for name, src in files.items():
        if src.exists():
            shutil.copy2(src, exe_dir / name)
            log(f"  Created {name}")
        else:
            log(f"  MISSING {name}")


def copy_goldberg_dlls(api_dir, exe_dir):
    """Copy Goldberg emulator DLLs."""
    for name, src in [
        ("steam_api64.dll", _find_dll("steam_api64.dll")),
        ("steamclient64.dll", _find_dll("steamclient64.dll")),
    ]:
        if src.exists():
            target_dir = api_dir if name == "steam_api64.dll" else exe_dir
            shutil.copy2(src, target_dir / name)
            log(f"  Created {name}")


# ─── INJECT TICKET ────────────────────────────────
def inject_ticket(cfg_path, token_b64, steam_id):
    """Inject the base64 ticket into configs.user.ini."""
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    if cfg_path.exists():
        lines = cfg_path.read_text(errors="ignore").splitlines()

    found_t = found_a = found_s = False
    new = []
    for line in lines:
        s = line.strip()
        if s.startswith("ticket="):
            new.append(f"ticket={token_b64}")
            found_t = True
        elif s.startswith("account_name="):
            new.append("account_name=Game_Gen")
            found_a = True
        elif s.startswith("account_steamid="):
            new.append(f"account_steamid={steam_id}")
            found_s = True
        else:
            new.append(line)

    if not (found_t and found_a and found_s):
        final = []
        injected = False
        for line in new:
            final.append(line)
            if not injected and line.strip() == "[user::general]":
                if not found_a:
                    final.append("account_name=Game_Gen")
                if not found_s:
                    final.append(f"account_steamid={steam_id}")
                if not found_t:
                    final.append(f"ticket={token_b64}")
                injected = True
        if not injected:
            final += [
                "[user::general]", "account_name=Game_Gen",
                f"account_steamid={steam_id}", f"ticket={token_b64}",
                "language=english",
            ]
        new = final

    cfg_path.write_text("\n".join(new), encoding="utf-8")


# ─── MAIN ─────────────────────────────────────────
def main(app_id, game_name, steampass_uuid):
    app_id = str(app_id)
    fake_mode = (steampass_uuid == "FAKE")

    # Prepare output directory
    out = TICKETS_DIR / app_id
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    if fake_mode:
        log(f"[FAKE MODE] Generating TEST token for {game_name} ({app_id})...")
        log("[FAKE MODE] Skipping Steam authentication — using placeholder ticket.")
        steam_id = "76561199000000001"
        # Distinctive fake payload so it's obvious this is a test, never a real ticket
        ticket_bytes = b"FAKE_TEST_TICKET_DO_NOT_USE_" * 32
        token_b64 = base64.b64encode(ticket_bytes).decode()
    else:
        # Steampass credentials from environment
        sp_login = os.environ.get("STEAMPASS_LOGIN")
        sp_password = os.environ.get("STEAMPASS_PASSWORD")
        if not sp_login or not sp_password:
            log("ERROR: STEAMPASS_LOGIN and STEAMPASS_PASSWORD env vars required")
            sys.exit(1)

        log(f"Generating token for {game_name} ({app_id})...")

        # ── Step 1: Get Steam credentials from steampass.gg ──
        log("Fetching Steam credentials from steampass.gg...")
        sp = SteampassClient(sp_login, sp_password)
        sp.authenticate()
        steam_login, steam_password, guarded = sp.get_steam_credentials(
            steampass_uuid)

        # ── Step 2: Get Steam Guard code if needed ──
        guard_code = None
        if guarded:
            log("Requesting Steam Guard code...")
            guard_code = sp.get_guard_code(steampass_uuid)

        # ── Step 3: Generate encrypted app ticket headlessly ──
        log("Connecting to Steam servers (headless)...")
        try:
            ticket_bytes, steam_id = get_encrypted_ticket_headless(
                app_id, steam_login, steam_password, guard_code)
        except RuntimeError as e:
            log(f"ERROR: {e}")
            sys.exit(1)

        token_b64 = base64.b64encode(ticket_bytes).decode()
        log(f"Token generated (SteamID: {steam_id})")

    # ── Step 4: Build output structure (template-first) ──
    tpl_status = get_template_status(app_id)
    use_template = (tpl_status == "ok")

    if use_template:
        tpl_dir = TEMPLATE_DIR / app_id
        log(f"Using template from _Template/{app_id}")
        shutil.copytree(tpl_dir, out, dirs_exist_ok=True)

        # Templates ship DLLs as 0-byte placeholders + a _dll_manifest.json that maps
        # each placeholder (relative path) to a specific variant in _Template/_dll_variants/.
        # This keeps the bundle deduplicated while preserving per-game DLL versions.
        manifest_path = out / "_dll_manifest.json"
        variants_dir = TEMPLATE_DIR / "_dll_variants"
        injected = 0
        missing = []

        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text())
            except Exception as e:
                manifest = {}
                log(f"  WARNING: failed to parse _dll_manifest.json: {e}")

            for rel_path, variant_name in manifest.items():
                target = out / rel_path
                src = variants_dir / variant_name
                if src.exists() and src.stat().st_size > 0:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, target)
                    injected += 1
                else:
                    missing.append(f"{rel_path} (variant: {variant_name})")

            # Don't ship the manifest in the user's zip
            manifest_path.unlink(missing_ok=True)
            log(f"  Injected {injected} DLL(s) from manifest variants")
        else:
            # Legacy fallback: any 0-byte *.dll → copy from _Core/ by filename
            for dll_path in out.rglob("*.dll"):
                core_src = CORE_DIR / dll_path.name
                if core_src.exists():
                    shutil.copy2(core_src, dll_path)
                    injected += 1
                else:
                    missing.append(dll_path.name)
            log(f"  Injected {injected} DLL(s) from _Core/ (no manifest)")

        if missing:
            log(f"  WARNING: missing variants/dlls: {sorted(set(missing))}")

        # If the template ships MKTL's coldloader, it needs a mktl.ini config file
        # next to it. Auto-generate one based on this game's appId, replacing any
        # stale or appid-mismatched mktl.ini that was bundled.
        # MKTL coldloader is identified by being significantly larger than the
        # custom one (~219 KB vs ~199 KB), but the safest signal is just: write
        # mktl.ini whenever a coldloader.dll exists in the output.
        for cl in out.rglob("coldloader.dll"):
            mktl_ini = cl.parent / "mktl.ini"
            mktl_ini.write_text(
                f"[settings]\nappid = {app_id}\ncleanup_delay = 10\n",
                encoding="utf-8"
            )
            log(f"  Wrote mktl.ini next to {cl.relative_to(out)} (appid={app_id})")

        # Find steam_settings dir (may be nested in exe subfolder)
        ss_dirs = list(out.rglob("steam_settings"))
        if ss_dirs:
            ss_dir = ss_dirs[0]
        else:
            ss_dir = out / "steam_settings"
            ss_dir.mkdir(parents=True, exist_ok=True)
        log("  Template copied")
    else:
        log("No template found — generating from scratch...")
        configs = _get_all_launch_configs(app_id)

        # Check for UE game (split DLL placement)
        ue = _detect_ue_structure(configs)
        if ue:
            game_path, exe_dir_path = ue
            log(f"UE game detected: {exe_dir_path}")

            # Define both target dirs up front
            engine_api_dir = out / "Engine" / "Binaries" / "ThirdParty" / "Steamworks" / "Steamv157" / "Win64"
            exe_dir = out / exe_dir_path
            engine_api_dir.mkdir(parents=True, exist_ok=True)
            exe_dir.mkdir(parents=True, exist_ok=True)

            # Engine path: steam_appid.txt + steam_api64.dll + steam_settings/
            generate_steam_settings(engine_api_dir, app_id, steam_id)

            # Goldberg DLLs split correctly:
            #   steam_api64.dll  → Engine path
            #   steamclient64.dll → game Win64 path (matches templates)
            copy_goldberg_dlls(engine_api_dir, exe_dir)

            # Coldloader + overlay + version + steamclient → game Win64 path
            copy_coldloader_files(exe_dir)

            ss_dir = engine_api_dir / "steam_settings"
            log("Generated UE template + DLLs")

        else:
            # Check for nested exe
            nested = _detect_nested_exe(configs)
            if nested and nested not in ["ArtBookwithMiniSoundtrack", "Artbook/book", "2KLauncher"]:
                exe_dir = out / nested
                log(f"Nested: {nested}")
            else:
                exe_dir = out
                log("Flat structure")

            exe_dir.mkdir(parents=True, exist_ok=True)
            ss_dir = exe_dir / "steam_settings"
            ss_dir.mkdir(parents=True, exist_ok=True)

            generate_steam_settings(exe_dir, app_id, steam_id)
            copy_coldloader_files(exe_dir)
            copy_goldberg_dlls(exe_dir, exe_dir)
            log("Generated steam_settings + DLLs")

    # Inject ticket into configs.user.ini (always — template or not)
    inject_ticket(ss_dir / "configs.user.ini", token_b64, steam_id)
    log("Injected ticket into configs.user.ini")

    # ── Step 5: Zip with game name ──
    safe_name = re.sub(r'[<>:"/\\|?*]', '', game_name).strip()
    prefix = "TEST" if fake_mode else "Token"
    zip_base = str(TICKETS_DIR / f"{prefix} [{safe_name}]")
    zip_path = shutil.make_archive(zip_base, 'zip', root_dir=str(out))
    log(f"Zipped: {zip_path}")

    # Clean temp folder
    shutil.rmtree(out, ignore_errors=True)

    # OUTPUT: last line = zip path (tokenGenerator.ts reads this)
    print(zip_path)


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(
            "Usage: python headless_token.py <appId> <gameName> <steampassUuid>",
            file=sys.stderr,
        )
        sys.exit(1)
    main(sys.argv[1], sys.argv[2], sys.argv[3])
