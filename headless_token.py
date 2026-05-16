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


def bundle_installer(out_dir, game_name, mode):
    """
    Drop _Core/installer.exe into the output folder (renamed per-game) and
    write a short README. Used by all three modes so the user always gets
    a zero-input deploy experience whether the token came from /tokengen
    or /test.

    The installer itself reads steam_settings/steam_appid.txt to find the
    appid, looks the game up via Steam's libraryfolders.vdf and
    appmanifest_<appid>.acf, and copies the zip's contents into the game
    folder root. For V1 it also auto-fixes ColdClientLoader.ini's Exe=
    line by scanning for a -Shipping.exe.

    Returns the chosen filename, or None if the installer binary hasn't
    been built yet (CI didn't run / failed).
    """
    src = CORE_DIR / "installer.exe"
    if not src.exists():
        log("WARN: _Core/installer.exe not built — shipping zip without auto-installer")
        return None

    safe_basename = re.sub(r'[<>:"/\\|?*]', '', game_name).strip() or "Game"
    installer_name = f"Install {safe_basename}.exe"
    shutil.copy2(src, out_dir / installer_name)

    # Per-mode entry-point hint. After install the user launches:
    #   V1  → start-<game>.exe sitting at the game folder root
    #   GBE → the game's own exe via Steam (we replaced the DLLs in place)
    #   V2  → the game's own exe directly (hijack DLL loads on startup)
    if mode == "coldclientloader":
        launch_hint = (
            f"3. Open your game folder and double-click \"start-{safe_basename}.exe\".\n"
            "   (Don't launch the game from Steam — always use the loader.)\n"
        )
    elif mode == "coldloader":
        launch_hint = (
            "3. Launch the game's exe directly (NOT through Steam). The\n"
            "   hijack DLL loads automatically and provides the ticket.\n"
        )
    else:  # gbe
        launch_hint = (
            "3. Launch the game as you normally would from Steam.\n"
        )

    (out_dir / "README - Read Me First.txt").write_text(
        "GameGen — How to play\n"
        "─────────────────────\n\n"
        f"1. Make sure {game_name} is installed via Steam.\n"
        f"2. Double-click \"{installer_name}\".\n"
        "   The installer finds your game folder automatically and\n"
        "   copies everything where it belongs. Approve the UAC\n"
        "   prompt if Windows asks.\n"
        f"{launch_hint}\n"
        "─────────────────────\n"
        "Note: the installer shares your game's folder structure (file\n"
        "and folder NAMES only — no file contents) with the GameGen\n"
        "team so we can add new games to the catalog faster.\n",
        encoding="utf-8",
    )
    log(f"Bundled installer: {installer_name}")
    return installer_name


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
        if not resp.ok:
            # Surface the actual API error message (credits exhausted, etc.)
            log(f"Steampass credentials API {resp.status_code} for UUID {product_uuid}: {resp.text[:500]}")
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
        if not resp.ok:
            # 422 here usually means: credits exhausted, UUID expired,
            # account currently in use by another session, or rate-limited.
            log(f"Steampass guard-code API {resp.status_code} for UUID {product_uuid}: {resp.text[:500]}")
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

    # Write steam_appid.txt to BOTH:
    #   - output_dir (where coldloader.dll lives, for coldloader to find)
    #   - output_dir/steam_settings/ (Goldberg's standard location)
    (output_dir / "steam_appid.txt").write_text(str(app_id))
    (ss / "steam_appid.txt").write_text(str(app_id))

    # account_steamid MUST be present and MUST match the steamid encoded in
    # the encrypted ticket — otherwise Denuvo's ticket-validation rejects and
    # the game reports "Steam API not initialized". Fall back to Goldberg's
    # canonical example steamid only if the caller really had nothing.
    sid = steam_id if steam_id else "76561197960287930"
    lines = [
        "[user::general]",
        "account_name=Game_Gen",
        f"account_steamid={sid}",
        "language=english",
    ]
    (ss / "configs.user.ini").write_text("\n".join(lines))

    (ss / "configs.overlay.ini").write_text(
        "[overlay::general]\nenable_experimental_overlay = 1\n")
    # disable_lan_only=0 (Goldberg default): emu intercepts the game's Steam
    # network calls. If we set this to 1 the game phones home to real Steam,
    # real Steam says "this account doesn't own the game", init fails.
    (ss / "configs.main.ini").write_text(
        "[main::connectivity]\n"
        "disable_lan_only=0\n"
        "disable_networking=0\n"
        "offline=0\n"
        "[main::general]\n"
        "new_app_ticket=1\n"
        "gc_token=1\n"
        "[main::misc]\n"
        "achievements_bypass=1\n"
    )

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
def main(app_id, game_name, steampass_uuid, generation_mode="gbe"):
    app_id = str(app_id)
    fake_mode = (steampass_uuid == "FAKE")

    # Valid modes: "gbe", "coldloader", "coldclientloader"
    if generation_mode not in ("gbe", "coldloader", "coldclientloader"):
        log(f"WARNING: unknown generation_mode '{generation_mode}', defaulting to 'gbe'")
        generation_mode = "gbe"
    log(f"Generation mode: {generation_mode}")

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

    # ── Step 4: Build output structure ──
    # In "gbe" mode (default), produce a flat layout:
    #   steam_api64.dll, steamclient64.dll, steam_settings/ at root.
    # Achievements/images come from the bundled template (if exists),
    # otherwise basic steam_settings is generated from Steam API.
    if generation_mode == "gbe":
        log("Building GBE output (preserves per-game folder structure, GBE files only)")
        tpl_dir = TEMPLATE_DIR / app_id

        # Files coldloader mode ships that GBE mode does NOT.
        # These get removed from the output if the template includes them.
        COLDLOADER_ONLY = {
            "coldloader.dll", "coldloader.ini", "mktl.ini",
            "GameOverlayRenderer64.dll",
            "version.dll", "winmm.dll", "dinput8.dll", "dsound.dll", "xinput1_3.dll",
            "steam_stubbed.dll", "steamclient.dll", "steamclient_extra_x64.dll",
        }
        # GBE-mode DLLs: shipped from _Core/ (universal GBE versions)
        GBE_DLLS = {"steam_api64.dll", "steamclient64.dll"}

        if tpl_dir.exists():
            log(f"Using bundled template structure from _Template/{app_id}")
            shutil.copytree(tpl_dir, out, dirs_exist_ok=True)

            # Read manifest to know which paths have DLL placeholders
            manifest_path = out / "_dll_manifest.json"
            manifest = {}
            if manifest_path.exists():
                try:
                    manifest = json.loads(manifest_path.read_text())
                except Exception as e:
                    log(f"  WARNING: bad manifest: {e}")
                manifest_path.unlink(missing_ok=True)

            # For every DLL placeholder in the manifest:
            #   - If filename is a GBE DLL, inject the GBE version from _Core/ at that path
            #   - Otherwise (it's a coldloader/proxy file), delete the placeholder
            for rel_path in manifest.keys():
                target = out / rel_path
                name = Path(rel_path).name
                if name in GBE_DLLS:
                    src = CORE_DIR / name
                    if src.exists():
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(src, target)
                        log(f"  GBE inject: {rel_path} <- _Core/{name}")
                    else:
                        log(f"  WARNING: missing _Core/{name}")
                else:
                    if target.exists():
                        target.unlink()
                        log(f"  Removed coldloader-only file: {rel_path}")

            # Sweep: remove any coldloader-only files left in the output that
            # weren't in the manifest (e.g. inline coldloader.ini from a template).
            for p in list(out.rglob("*")):
                if p.is_file() and p.name in COLDLOADER_ONLY:
                    p.unlink()

            # Clean up now-empty directories left behind by the removals
            for d in sorted(out.rglob("*"), key=lambda p: len(str(p)), reverse=True):
                if d.is_dir() and not any(d.iterdir()):
                    d.rmdir()

            # If the template didn't ship a steam_api64.dll placeholder, drop one
            # at a reasonable location. Prefer Engine path if we detect UE; else root.
            if not any(p.name == "steam_api64.dll" for p in out.rglob("*.dll")):
                # Try to find an Engine/Binaries/.../Win64 folder in the template
                engine_dirs = [p for p in out.rglob("*") if p.is_dir() and p.name == "Win64" and "Steamworks" in p.as_posix()]
                target = (engine_dirs[0] / "steam_api64.dll") if engine_dirs else (out / "steam_api64.dll")
                shutil.copy2(CORE_DIR / "steam_api64.dll", target)
                log(f"  GBE inject (default path): {target.relative_to(out).as_posix()}")
            if not any(p.name == "steamclient64.dll" for p in out.rglob("*.dll")):
                shutil.copy2(CORE_DIR / "steamclient64.dll", out / "steamclient64.dll")
                log("  GBE inject (default path): steamclient64.dll")
        else:
            # No bundled template — auto-gen GBE layout based on Steam API detection
            log("No bundled template — auto-generating GBE layout from Steam API")
            configs = _get_all_launch_configs(app_id)
            ue = _detect_ue_structure(configs)
            if ue:
                _, exe_dir_path = ue
                engine_api_dir = out / "Engine" / "Binaries" / "ThirdParty" / "Steamworks" / "Steamv157" / "Win64"
                exe_dir = out / exe_dir_path
                engine_api_dir.mkdir(parents=True, exist_ok=True)
                exe_dir.mkdir(parents=True, exist_ok=True)
                generate_steam_settings(engine_api_dir, app_id, steam_id)
                shutil.copy2(CORE_DIR / "steam_api64.dll", engine_api_dir / "steam_api64.dll")
                shutil.copy2(CORE_DIR / "steamclient64.dll", exe_dir / "steamclient64.dll")
            else:
                nested = _detect_nested_exe(configs)
                exe_dir = out / nested if nested and nested not in ["ArtBookwithMiniSoundtrack", "Artbook/book", "2KLauncher"] else out
                exe_dir.mkdir(parents=True, exist_ok=True)
                generate_steam_settings(exe_dir, app_id, steam_id)
                shutil.copy2(CORE_DIR / "steam_api64.dll", exe_dir / "steam_api64.dll")
                shutil.copy2(CORE_DIR / "steamclient64.dll", exe_dir / "steamclient64.dll")

        # Find the steam_settings folder (template put it somewhere) and inject ticket
        ss_candidates = list(out.rglob("steam_settings"))
        if not ss_candidates:
            log("ERROR: no steam_settings/ in GBE output")
            sys.exit(1)
        ss_dir = ss_candidates[0]
        inject_ticket(ss_dir / "configs.user.ini", token_b64, steam_id)
        log(f"Injected ticket into {ss_dir.relative_to(out).as_posix()}/configs.user.ini")

        # Ensure steam_appid.txt is alongside steam_api64.dll (so ColdClientLoader/etc work)
        for api in out.rglob("steam_api64.dll"):
            (api.parent / "steam_appid.txt").write_text(str(app_id))

        bundle_installer(out, game_name, "gbe")

        safe_name = re.sub(r'[<>:"/\\|?*]', '', game_name).strip()
        prefix = "TEST" if fake_mode else "Token"
        zip_base = str(TICKETS_DIR / f"{prefix} [{safe_name}]")
        zip_path = shutil.make_archive(zip_base, 'zip', root_dir=str(out))
        log(f"Zipped: {zip_path}")
        shutil.rmtree(out, ignore_errors=True)
        print(zip_path)
        return

    # ──────────────────────────────────────────────────────────────
    # ColdClientLoader (V1) mode
    # Per goldberg_emulator/steamclient_experimental README:
    #   - User keeps their game's original steam_api64.dll
    #   - We ship a launcher exe + steamclient(64).dll + ColdClientLoader.ini
    #     + steam_settings/ (with ticket) — all in ONE folder
    #   - GameOverlayRenderer(64).dll recommended (some games check for it)
    #   - User runs the loader exe, which spawns the game with steamclient
    #     hooked in
    # ──────────────────────────────────────────────────────────────
    if generation_mode == "coldclientloader":
        log("Building ColdClientLoader V1 output...")
        cc_src = CORE_DIR / "coldclientloader"
        if not cc_src.exists():
            log(f"ERROR: missing {cc_src}. Cannot build coldclientloader output.")
            sys.exit(1)

        # 1. Copy V1 base files (loader + steamclient + overlay) into output root.
        # 32-bit loader intentionally NOT shipped — all our supported games are x64.
        # The loader gets renamed to "start-<game>.exe" so the user sees a clear
        # entry point instead of the generic "steamclient_loader_x64.exe".
        safe_loader_name = re.sub(r'[<>:"/\\|?*]', '', game_name).strip()
        if not safe_loader_name:
            safe_loader_name = f"app{app_id}"
        loader_out_name = f"start-{safe_loader_name}.exe"
        loader_src = cc_src / "steamclient_loader_x64.exe"
        if loader_src.exists():
            shutil.copy2(loader_src, out / loader_out_name)
        for fname in [
            "steamclient.dll",
            "steamclient64.dll",
            "GameOverlayRenderer.dll",
            "GameOverlayRenderer64.dll",
        ]:
            src = cc_src / fname
            if src.exists():
                shutil.copy2(src, out / fname)

        # 2. steam_settings: from bundled template (preserves achievements,
        #    images, configs) OR generated fresh from Steam API.
        ss_dir = out / "steam_settings"
        ss_dir.mkdir(parents=True, exist_ok=True)
        tpl_dir = TEMPLATE_DIR / app_id
        tpl_ss = None
        if tpl_dir.exists():
            cand = list(tpl_dir.rglob("steam_settings"))
            tpl_ss = cand[0] if cand else None
        if tpl_ss and tpl_ss.is_dir():
            log(f"Copying steam_settings from _Template/{app_id}/{tpl_ss.relative_to(tpl_dir)}")
            shutil.copytree(tpl_ss, ss_dir, dirs_exist_ok=True)
        else:
            log("No bundled steam_settings — generating from Steam API")
            generate_steam_settings(out, app_id, steam_id)

        # Always write steam_appid.txt inside steam_settings (loader reads it
        # from there when AppId= is left empty in the ini)
        (ss_dir / "steam_appid.txt").write_text(str(app_id))

        # 3. Detect the game's main exe path (relative) from Steam launch configs.
        # Priority order:
        #   Pass 1: anything containing "-shipping" (e.g. APK2-Win64-Shipping.exe)
        #           — UE/Unity shipping binary, the real entry point
        #   Pass 2: anything containing "win64" / "win32" path segment but not
        #           a known junk binary (launcher/artbook/etc)
        #   Pass 3: first usable config that isn't junk
        #   Pass 4: literally the first config if everything got filtered
        configs = _get_all_launch_configs(app_id)
        game_exe = "game.exe"  # fallback if Steam API has nothing
        skip = {"artbook", "launcher", "2klauncher", "book", "crashreport", "redist", "vc_redist"}

        def _is_junk(p: str) -> bool:
            return any(s in p.lower() for s in skip)

        chosen = None
        # Pass 1: prefer -Shipping binaries (UE/Unity real game exe)
        for c in configs:
            if "-shipping" in c.lower() and not _is_junk(c):
                chosen = c
                break
        # Pass 2: prefer binaries under Win64/Win32 path
        if not chosen:
            for c in configs:
                low = c.lower()
                if ("/win64/" in low.replace("\\", "/") or "/win32/" in low.replace("\\", "/")) and not _is_junk(c):
                    chosen = c
                    break
        # Pass 3: first non-junk config
        if not chosen:
            for c in configs:
                if not _is_junk(c):
                    chosen = c
                    break
        # Pass 4: absolute fallback
        if not chosen and configs:
            chosen = configs[0]
        if chosen:
            # Normalize backslashes; relative path from loader (which sits
            # at the game folder root) directly to the exe
            game_exe = chosen.replace("\\", "/")
            log(f"Picked Exe= from {len(configs)} Steam launch config(s): {game_exe}")

        # 4. Write a fresh ColdClientLoader.ini with this game's specifics.
        # ForceInjectSteamClient=1 is REQUIRED for Denuvo titles — many ship
        # their own steamclient64.dll next to the exe, and without forced
        # injection Windows loads the game's copy instead of Goldberg's.
        # That makes Denuvo talk to real Steam → real Steam rejects the
        # account → "Steam API not initialized".
        # ForceInjectGameOverlayRenderer=1 because some Denuvo wrappers
        # verify the overlay DLL is actually mapped into the process, not
        # just present on disk.
        ini = (
            "# Generated by GameGen bot. ColdClientLoader v1 (Goldberg/Rat431).\n"
            "[SteamClient]\n"
            f"Exe={game_exe}\n"
            "ExeRunDir=\n"
            "ExeCommandLine=\n"
            f"AppId={app_id}\n"
            "SteamClientDll=steamclient.dll\n"
            "SteamClient64Dll=steamclient64.dll\n"
            "\n"
            "[Injection]\n"
            "ForceInjectSteamClient=1\n"
            "ForceInjectGameOverlayRenderer=1\n"
            "DllsToInjectFolder=\n"
            "IgnoreInjectionError=1\n"
            "IgnoreLoaderArchDifference=0\n"
            "\n"
            "[Persistence]\n"
            "Mode=0\n"
            "\n"
            "[Debug]\n"
            "ResumeByDebugger=0\n"
        )
        (out / "ColdClientLoader.ini").write_text(ini, encoding="utf-8")
        log(f"Wrote ColdClientLoader.ini (Exe={game_exe}, AppId={app_id})")

        # 5. Inject ticket into configs.user.ini
        inject_ticket(ss_dir / "configs.user.ini", token_b64, steam_id)
        log("Injected ticket into steam_settings/configs.user.ini")

        # 6. Bundle the auto-installer + README
        bundle_installer(out, game_name, "coldclientloader")

        # 7. Zip
        safe_name = re.sub(r'[<>:"/\\|?*]', '', game_name).strip()
        prefix = "TEST" if fake_mode else "Token"
        zip_base = str(TICKETS_DIR / f"{prefix} [{safe_name}]")
        zip_path = shutil.make_archive(zip_base, 'zip', root_dir=str(out))
        log(f"Zipped: {zip_path}")
        shutil.rmtree(out, ignore_errors=True)
        print(zip_path)
        return

    # ── Mode coldloader: original template-first flow ──
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

    # Write coldloader.ini next to every coldloader.dll in the output, with
    # the correct appid. The custom 199 KB coldloader.dll (the only one we
    # use) reads this file — without it, the loader errors with "appid not
    # found". Runs for BOTH the template path and auto-gen path.
    #
    # We deliberately do NOT write mktl.ini: only MKTL's own (different)
    # coldloader.dll reads that, and we don't ship MKTL's coldloader.
    cl_count = 0
    for cl in out.rglob("coldloader.dll"):
        (cl.parent / "coldloader.ini").write_text(
            "[settings]\n"
            f"appid = {app_id}\n"
            "steamclient64 = steamclient64.dll\n"
            "steamclient = steamclient.dll\n"
            "cleanup_delay = 10\n",
            encoding="utf-8"
        )
        # Also delete any stale mktl.ini that may have been bundled in a
        # template from earlier versions of this codebase.
        stale = cl.parent / "mktl.ini"
        if stale.exists():
            stale.unlink()
        cl_count += 1
    if cl_count:
        log(f"Wrote coldloader.ini next to {cl_count} coldloader.dll location(s) (appid={app_id})")

    # Inject ticket into configs.user.ini (always — template or not)
    inject_ticket(ss_dir / "configs.user.ini", token_b64, steam_id)
    log("Injected ticket into configs.user.ini")

    bundle_installer(out, game_name, "coldloader")

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
            "Usage: python headless_token.py <appId> <gameName> <steampassUuid> [generationMode]\n"
            "  generationMode: gbe (default) | coldloader | coldclientloader",
            file=sys.stderr,
        )
        sys.exit(1)
    mode = sys.argv[4] if len(sys.argv) >= 5 else "gbe"
    main(sys.argv[1], sys.argv[2], sys.argv[3], generation_mode=mode)
