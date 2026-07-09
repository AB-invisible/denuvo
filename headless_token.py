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
import sys, os, json, shutil, re, time, base64, struct, hashlib, hmac
import requests
from pathlib import Path

# ─── CONFIG ───────────────────────────────────────
# Templates are CONSULTED when present (the installer's capture webhook
# grows _Template/ over time for troubleshooting), but every game without
# a template falls back to a fully dynamic generate_steam_settings() —
# so no game ever fails for "no template", and bad templates can be
# deleted without breaking gen. See _resolve_steam_settings() for the
# precedence + 0-byte scrub that defends against capture-artifact crashes.
PROJECT_ROOT = Path(__file__).resolve().parent
TEMPLATE_DIR = PROJECT_ROOT / "_Template"
TICKETS_DIR  = PROJECT_ROOT / "Generated_Tokens"
CORE_DIR     = PROJECT_ROOT / "_Core"


def _public_base_url():
    """Resolve the bot's public base URL for installer downloads.
    Prefers PUBLIC_URL env var; falls back to RAILWAY_PUBLIC_DOMAIN.
    Auto-prepends https:// if the user supplied a bare domain."""
    explicit = os.environ.get("PUBLIC_URL", "").strip().rstrip("/")
    if explicit:
        if not re.match(r"^https?://", explicit, re.IGNORECASE):
            explicit = "https://" + explicit
        return explicit
    railway = os.environ.get("RAILWAY_PUBLIC_DOMAIN", "").strip()
    if railway:
        return f"https://{railway}"
    return None


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

STEAMPASS_API = "https://steampass.gg/api"

for d in [TEMPLATE_DIR, TICKETS_DIR, CORE_DIR]:
    d.mkdir(exist_ok=True)


def log(msg):
    print(msg, flush=True)


def _resolve_steam_settings(out_dir, app_id, steam_id):
    """Populate out_dir/steam_settings/ using the best available source.

    Precedence:
      1. _Template/<app_id>/**/steam_settings/  — if a template exists and
         has a steam_settings/ subtree, copy it (then scrub 0-byte capture
         artifacts that would crash Goldberg's load_dlls/ auto-loader).
         This preserves any hand-curated achievements/icons/sounds the
         template carries.
      2. Otherwise, dynamic generation via generate_steam_settings() — a
         working baseline (ticket-injection-ready configs, comprehensive
         steam_interfaces.txt, DLC list from appdetails, depots from
         steamcmd.net). Enough for every Denuvo activation; no overlay
         icons but the game runs.

    `inject_ticket()` runs after this regardless, so the freshly-generated
    encrypted ticket + account_steamid always land in configs.user.ini
    even when the template had a pre-baked one.
    """
    ss_dir = out_dir / "steam_settings"
    ss_dir.mkdir(parents=True, exist_ok=True)

    tpl_dir = TEMPLATE_DIR / app_id
    tpl_ss = None
    if tpl_dir.exists():
        cand = list(tpl_dir.rglob("steam_settings"))
        tpl_ss = cand[0] if cand else None

    if tpl_ss and tpl_ss.is_dir():
        log(f"steam_settings/: using template _Template/{app_id}/{tpl_ss.relative_to(tpl_dir)}")
        shutil.copytree(tpl_ss, ss_dir, dirs_exist_ok=True)
        # Defensive 0-byte scrub: the capture webhook writes 0-byte
        # placeholders, and one in steam_settings/load_dlls/ would crash
        # ColdClientLoader at startup with STATUS_INVALID_IMAGE_FORMAT.
        # Real Goldberg config + DLLs are never empty, so deleting any
        # 0-byte file is always safe.
        scrubbed = 0
        for f in ss_dir.rglob("*"):
            if f.is_file() and f.stat().st_size == 0:
                try:
                    f.unlink()
                    scrubbed += 1
                except OSError as e:
                    log(f"WARN: couldn't remove 0-byte template artifact {f}: {e}")
        if scrubbed:
            log(f"steam_settings/: scrubbed {scrubbed} zero-byte capture artifact(s)")
    else:
        log(f"steam_settings/: no template for AppID {app_id}, generating dynamically")
        generate_steam_settings(out_dir, app_id, steam_id)


def _steampass_request(session_callable, *args, **kwargs):
    """Wrap a steampass HTTP call with a single retry on transient
    network errors. steampass.gg occasionally takes >15s to respond
    (especially for product-credentials and email/code), and a bare
    ReadTimeout would fail the entire token-gen run. Bumping the
    timeout to 45s + one retry covers >99% of those cases.

    Callers still supply timeout=... via kwargs; if absent, defaults
    to 45s here.
    """
    kwargs.setdefault("timeout", 45)
    last_exc = None
    for attempt in (1, 2):
        try:
            return session_callable(*args, **kwargs)
        except (requests.exceptions.ReadTimeout,
                requests.exceptions.ConnectTimeout,
                requests.exceptions.ConnectionError) as e:
            last_exc = e
            log(f"Steampass: transient network error on attempt {attempt} "
                f"({type(e).__name__}: {str(e)[:120]}). "
                f"{'Retrying...' if attempt == 1 else 'Giving up.'}")
    raise last_exc


def build_thin_zip(out, app_id, game_name, generation_mode, token_b64, steam_id, fake_mode, base_url):
    """
    Thin token zip that points the installer at a payload HTTP server for
    the heavy Goldberg binaries. Keeps the zip small (~2 MB) instead of
    ~50 MB — the user only ever downloads the mode that actually works.

    Layout:
        Install <Game>.exe
        README - Read Me First.txt
        gamegen-modes.txt              ← "primary=<mode>"
        steam_settings/                ← shared (ticket injected)
        payload-manifest.json          ← URLs + sha256 for the installer to fetch

    The manifest describes both modes; the installer downloads the primary
    first, probes, and if the game exits within ~45 s, deletes those
    files, downloads the alternate, and tries again.
    """
    out.mkdir(parents=True, exist_ok=True)

    # ── Shared steam_settings/ ──
    _resolve_steam_settings(out, app_id, steam_id)
    ss_dir = out / "steam_settings"
    (ss_dir / "steam_appid.txt").write_text(str(app_id))
    stray = out / "steam_appid.txt"
    if stray.exists():
        stray.unlink()
    inject_ticket(ss_dir / "configs.user.ini", token_b64, steam_id)
    log("Injected ticket into shared steam_settings/configs.user.ini")

    # ── Build the payload manifest by hashing the local _Core/ files ──
    safe_loader = re.sub(r'[<>:"/\\|?*]', '', game_name).strip() or f"app{app_id}"

    def _entry(src_path, src_url, dst_name):
        """Manifest record for one downloadable file."""
        if not src_path.exists():
            return None
        return {
            "url": src_url,                 # relative to base_url
            "dst": dst_name,                # filename the installer writes
            "sha256": _sha256_file(src_path),
            "size": src_path.stat().st_size,
        }

    gbe_entries = []
    for name in ("steam_api64.dll", "steamclient64.dll"):
        e = _entry(CORE_DIR / name, f"/payload/gbe/{name}", name)
        if e:
            gbe_entries.append(e)

    cc_src = CORE_DIR / "coldclientloader"
    v1_entries = []
    if cc_src.exists():
        loader_src = cc_src / "steamclient_loader_x64.exe"
        e = _entry(loader_src, "/payload/v1/steamclient_loader_x64.exe", f"start-{safe_loader}.exe")
        if e:
            v1_entries.append(e)
        for fname in (
            "steamclient.dll",
            "steamclient64.dll",
            "GameOverlayRenderer.dll",
            "GameOverlayRenderer64.dll",
        ):
            e = _entry(cc_src / fname, f"/payload/v1/{fname}", fname)
            if e:
                v1_entries.append(e)

    v1_ini_content = (
        "# Generated by GameGen bot. ColdClientLoader v1 (Goldberg/Rat431).\n"
        "[SteamClient]\n"
        "Exe=PLACEHOLDER_INSTALLER_WILL_FIX.exe\n"
        "ExeRunDir=\n"
        "ExeCommandLine=\n"
        f"AppId={app_id}\n"
        "SteamClientDll=steamclient.dll\n"
        "SteamClient64Dll=steamclient64.dll\n"
        "\n[Injection]\n"
        "ForceInjectSteamClient=1\n"
        "ForceInjectGameOverlayRenderer=1\n"
        "DllsToInjectFolder=\n"
        "IgnoreInjectionError=1\n"
        "IgnoreLoaderArchDifference=0\n"
        "\n[Persistence]\nMode=0\n"
        "\n[Debug]\nResumeByDebugger=0\n"
    )

    # ── V2 (coldloader) payload ──
    # DLL-hijack mode: a small proxy DLL (version.dll, dinput8.dll, etc.)
    # sits next to the game's exe, gets auto-loaded by Windows' DLL
    # search order, and loads coldloader.dll which in turn provides the
    # Steam emulator. No separate loader.exe — user just runs the game's
    # normal binary. Goldberg's coldloader.dll reads coldloader.ini for
    # the app id.
    #
    # V2 ships Goldberg's steamclient64.dll alongside coldloader.dll —
    # coldloader's hooks relay intercepted steamclient calls to it, and
    # for games that haven't been launched yet (so the game's own
    # steamclient64.dll isn't on disk) ours is the only one available.
    #
    # V2 deliberately does NOT ship steam_api64.dll. The game's own
    # copy is preferred when present; for games that lazily extract it
    # on first launch we'll add a stubbed/experimental Goldberg variant
    # later (the GBE flat one we have in _Core/ would conflict with
    # coldloader's hooks if used here).
    v2_entries = []
    # Hijack proxy + coldloader emulator core + overlay — these all live
    # at _Core/ root and the payload server serves them from there.
    # version.dll is the most universally supported hijack proxy. If a
    # specific game needs winmm.dll or dinput8.dll instead, we can
    # per-game override later — version.dll covers ~90% of cases.
    for fname in ("version.dll", "coldloader.dll", "GameOverlayRenderer64.dll"):
        e = _entry(CORE_DIR / fname, f"/payload/v2/{fname}", fname)
        if e:
            v2_entries.append(e)

    # steamclient64.dll is special — V2 needs the FULL experimental
    # Goldberg variant (~21 MB) that lives in _Core/coldclientloader/,
    # NOT the small ~112 KB stub at _Core/steamclient64.dll. coldloader.dll
    # relays intercepted steamclient calls to a real steamclient64.dll
    # implementation; the stub doesn't have those internals so the relay
    # fails silently and the game errors out. The /payload/v1/ URL
    # already maps to _Core/coldclientloader/ on the payload server, so
    # we reuse that route here — no payloadServer.ts change needed.
    if cc_src.exists():
        e = _entry(
            cc_src / "steamclient64.dll",
            "/payload/v1/steamclient64.dll",
            "steamclient64.dll",
        )
        if e:
            v2_entries.append(e)
    v2_ini_content = (
        "[settings]\n"
        f"appid = {app_id}\n"
        "cleanup_delay = 10\n"
    )

    # `primary` is the bot's hint for which mode the installer should
    # deploy. Anything else gets coerced to coldclientloader as a safe
    # default — but we now accept all three real modes explicitly so a
    # game /setmode'd to coldloader actually gets V2 instead of being
    # silently downgraded to V1 (which was the bug behind the user's
    # Crimson Desert complaint).
    primary = (
        generation_mode
        if generation_mode in ("gbe", "coldclientloader", "coldloader")
        else "coldclientloader"
    )

    # Per-zip activation key. The Node bot pre-generated this and passed
    # it through INSTALLER_KEY so the same 48-hex value lands in BOTH
    # this manifest (under `_sig`) AND the TokenDownload DB row's
    # installerKey column. The installer POSTs it back to
    # /installer-validate/<sig> on first run — bot marks consumed, any
    # subsequent run gets 410 → nuclear self-destruct.
    installer_key = (os.environ.get("INSTALLER_KEY") or "").strip()

    # HMAC anti-swap binding. Without this, a pirate with their own
    # unused key (PA) could swap _sig in another user's zip to PA,
    # validate, and consume PA — sharing one game's bought key across
    # multiple games. With HMAC, the installer must also send a
    # signature that cryptographically ties (sig + app_id + ticket_hash)
    # together. Forging the HMAC requires the server-side SECRET.
    #
    # If HMAC_SECRET isn't configured, fall back to the consumed-only
    # protection (legacy behavior). Production should always set it.
    hmac_secret = (os.environ.get("HMAC_SECRET") or "").strip()
    ticket_hash = hashlib.sha256(token_b64.encode("utf-8")).hexdigest()
    installer_hmac = ""
    if hmac_secret and installer_key:
        payload_bytes = f"{installer_key}|{app_id}|{ticket_hash}".encode("utf-8")
        installer_hmac = hmac.new(
            hmac_secret.encode("utf-8"),
            payload_bytes,
            hashlib.sha256,
        ).hexdigest()
        log("HMAC: bound installer key to ticket hash")
    else:
        log("HMAC: HMAC_SECRET not set — anti-swap binding skipped (consumed-only mode)")

    manifest = {
        "manifest_version": 1,
        "base_url": base_url,
        "primary": primary,
        "app_id": app_id,
        "game_name": game_name,
        "_sig": installer_key,
        # /test command marker. When true, the installer skips activation-
        # key validation, skips the Steam library lookup, deploys into a
        # fake game folder on the user's Desktop, and opens it in Explorer
        # so staff can visually inspect what would have been installed.
        # The fake-ticket bytes inside this zip are useless against real
        # Denuvo anyway, and the worst case of someone forging this flag
        # is they get a fake folder instead of a real activation — no
        # exploitable bypass of the single-use enforcement.
        "_test_mode": fake_mode,
        # Anti-swap fields. _th = sha256 of the ticket bytes (so server
        # can verify the manifest is still paired with the original
        # ticket). _hmac = signature over (sig|app_id|_th) so even a
        # swapped manifest can't be made to match without the SECRET.
        "_th": ticket_hash,
        "_hmac": installer_hmac,
        "modes": {
            "gbe": {"files": gbe_entries},
            "coldclientloader": {
                "files": v1_entries,
                # The installer writes this file verbatim to game_dir/ColdClientLoader.ini
                # after downloading the V1 binaries.
                "ini_filename": "ColdClientLoader.ini",
                "ini_content": v1_ini_content,
            },
            "coldloader": {
                "files": v2_entries,
                # coldloader.dll reads this for the app id at runtime.
                # Installer drops it next to the hijack DLL (which lives
                # next to the game's main exe).
                "ini_filename": "coldloader.ini",
                "ini_content": v2_ini_content,
            },
        },
    }
    (out / "payload-manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    log(f"Manifest written. base_url={base_url}, primary={primary}")

    # Marker for the installer's existing detector (legacy support)
    (out / "gamegen-modes.txt").write_text(f"primary={primary}\n", encoding="utf-8")

    # ── Installer + README ──
    bundle_installer(out, game_name, primary)

    # ── Zip + cleanup ──
    safe_name = re.sub(r'[<>:"/\\|?*]', '', game_name).strip()
    prefix = "TEST" if fake_mode else "Token"
    zip_base = str(TICKETS_DIR / f"{prefix} [{safe_name}]")
    zip_path = shutil.make_archive(zip_base, "zip", root_dir=str(out))
    log(f"Zipped (thin): {zip_path}")
    shutil.rmtree(out, ignore_errors=True)

    # Sidecar JSON: lets the Node bot pick up the HMAC + ticket_hash +
    # the Steam session info (login/password/refresh_token) without
    # re-parsing the manifest from inside the just-zipped file. Node
    # writes the session block to the SteamSession DB row so the next
    # gen can skip steampass. File is deleted by Node after read.
    try:
        meta = {
            "installer_key": installer_key,
            "ticket_hash": ticket_hash,
            "expected_hmac": installer_hmac,
            "app_id": app_id,
            # Steam session cache — main() stashed these into os.environ
            # under _GAMEGEN_NEW_* keys before calling us. Empty strings
            # mean "no data" (skip the cache update on the Node side).
            "session_source": os.environ.get("_GAMEGEN_SESSION_SOURCE") or None,
            "steam_login":    os.environ.get("_GAMEGEN_NEW_STEAM_LOGIN") or None,
            "steam_password": os.environ.get("_GAMEGEN_NEW_STEAM_PASSWORD") or None,
            "steam_id":       os.environ.get("_GAMEGEN_NEW_STEAM_ID") or None,
            "refresh_token":  os.environ.get("_GAMEGEN_NEW_REFRESH_TOKEN") or None,
            "guarded":        (os.environ.get("_GAMEGEN_NEW_STEAM_GUARDED") or "true").lower() == "true",
        }
        Path(zip_path + ".meta.json").write_text(json.dumps(meta), encoding="utf-8")
    except OSError as e:
        log(f"WARN: couldn't write sidecar meta json: {e}")

    return zip_path


def build_multi_mode_zip(out, app_id, game_name, generation_mode, token_b64, steam_id, fake_mode):
    """
    Produce a multi-mode token zip that the installer's auto-probe can
    work with. Both GBE and V1 payloads ship side-by-side; the marker
    file tells the installer which to try first.

    Layout:
        Install <Game>.exe
        README - Read Me First.txt
        gamegen-modes.txt              ← "primary=<mode>"
        steam_settings/                ← shared (ticket injected)
        gamegen-modes/
          gbe/
            steam_api64.dll
            steamclient64.dll
          v1/
            loader.exe
            steamclient.dll
            steamclient64.dll
            GameOverlayRenderer.dll
            GameOverlayRenderer64.dll
            ColdClientLoader.ini       ← Exe= placeholder; installer fixes on disk

    Returns the absolute path of the produced .zip.
    """
    out.mkdir(parents=True, exist_ok=True)

    # ── Shared steam_settings/ ──
    _resolve_steam_settings(out, app_id, steam_id)
    ss_dir = out / "steam_settings"
    (ss_dir / "steam_appid.txt").write_text(str(app_id))
    stray = out / "steam_appid.txt"
    if stray.exists():
        stray.unlink()

    inject_ticket(ss_dir / "configs.user.ini", token_b64, steam_id)
    log("Injected ticket into shared steam_settings/configs.user.ini")

    # ── GBE payload ──
    modes_dir = out / "gamegen-modes"
    gbe_dir = modes_dir / "gbe"
    gbe_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(CORE_DIR / "steam_api64.dll", gbe_dir / "steam_api64.dll")
    shutil.copy2(CORE_DIR / "steamclient64.dll", gbe_dir / "steamclient64.dll")
    log("Built GBE payload (gamegen-modes/gbe/)")

    # ── V1 payload ──
    v1_dir = modes_dir / "v1"
    v1_dir.mkdir(parents=True, exist_ok=True)
    cc_src = CORE_DIR / "coldclientloader"
    if cc_src.exists():
        # Loader gets a canonical name in the zip; the installer renames it
        # to "start-<Game>.exe" on deploy (and the V1 polish step then
        # renames to "<Game>.exe" + creates the desktop shortcut).
        loader_src = cc_src / "steamclient_loader_x64.exe"
        if loader_src.exists():
            safe_loader = re.sub(r'[<>:"/\\|?*]', '', game_name).strip() or f"app{app_id}"
            shutil.copy2(loader_src, v1_dir / f"start-{safe_loader}.exe")
        for fname in (
            "steamclient.dll",
            "steamclient64.dll",
            "GameOverlayRenderer.dll",
            "GameOverlayRenderer64.dll",
        ):
            src = cc_src / fname
            if src.exists():
                shutil.copy2(src, v1_dir / fname)
        # Exe= placeholder — installer scans the game folder for a real
        # *-Shipping.exe and rewrites the line before probing.
        ini = (
            "# Generated by GameGen bot. ColdClientLoader v1 (Goldberg/Rat431).\n"
            "[SteamClient]\n"
            "Exe=PLACEHOLDER_INSTALLER_WILL_FIX.exe\n"
            "ExeRunDir=\n"
            "ExeCommandLine=\n"
            f"AppId={app_id}\n"
            "SteamClientDll=steamclient.dll\n"
            "SteamClient64Dll=steamclient64.dll\n"
            "\n[Injection]\n"
            "ForceInjectSteamClient=1\n"
            "ForceInjectGameOverlayRenderer=1\n"
            "DllsToInjectFolder=\n"
            "IgnoreInjectionError=1\n"
            "IgnoreLoaderArchDifference=0\n"
            "\n[Persistence]\nMode=0\n"
            "\n[Debug]\nResumeByDebugger=0\n"
        )
        (v1_dir / "ColdClientLoader.ini").write_text(ini, encoding="utf-8")
        log("Built V1 payload (gamegen-modes/v1/)")
    else:
        log("WARN: _Core/coldclientloader/ missing — V1 auto-fallback won't be available")

    # ── Marker file ──
    primary = (
        generation_mode
        if generation_mode in ("gbe", "coldclientloader")
        else "coldclientloader"
    )
    (out / "gamegen-modes.txt").write_text(f"primary={primary}\n", encoding="utf-8")
    log(f"Marker: primary={primary}")

    # ── Installer + README ──
    bundle_installer(out, game_name, primary)

    # ── Zip + cleanup ──
    safe_name = re.sub(r'[<>:"/\\|?*]', '', game_name).strip()
    prefix = "TEST" if fake_mode else "Token"
    zip_base = str(TICKETS_DIR / f"{prefix} [{safe_name}]")
    zip_path = shutil.make_archive(zip_base, "zip", root_dir=str(out))
    log(f"Zipped: {zip_path}")
    shutil.rmtree(out, ignore_errors=True)
    return zip_path


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
        # The installer renames the loader to "<Game>.exe" and also
        # drops a desktop shortcut named "<Game>" with the game's icon.
        # Don't mention "start-<Game>.exe" — that intermediate name
        # only exists for the few seconds between deploy and rename.
        launch_hint = (
            f"3. Once the installer finishes, double-click the\n"
            f"   \"{safe_basename}\" shortcut on your Desktop to play.\n"
        )
    elif mode == "coldloader":
        launch_hint = (
            "3. Once the installer finishes, launch the game's main .exe\n"
            "   directly from the game folder (NOT through Steam). The\n"
            "   hijack DLL loads automatically and provides the ticket.\n"
        )
    else:  # gbe
        launch_hint = (
            "3. Once the installer finishes, launch the game from Steam\n"
            "   like you normally would.\n"
        )

    (out_dir / "README - Read Me First.txt").write_text(
        "GameGen — How to play\n"
        "─────────────────────\n\n"
        f"1. Make sure {game_name} is installed via Steam.\n"
        f"2. Double-click \"{installer_name}\".\n"
        "   The installer finds your game folder automatically and\n"
        "   copies everything where it belongs. Approve the UAC\n"
        "   prompt if Windows asks.\n"
        f"{launch_hint}",
        encoding="utf-8",
    )
    log(f"Bundled installer: {installer_name}")
    return installer_name


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
        """
        Get a usable bearer token for steampass.gg API calls.

        Priority order:
          1. Cached bearer token in STEAMPASS_TOKEN env var (set by the
             Node bot from its DB-stored session). Skips POST /auth/login
             entirely — no email code prompt, no rate-limit hit, no IP-
             ban risk. This is the normal path 99% of the time.
          2. Fresh username+password login via POST /auth/login. Only
             happens if no cached token exists, or if a previous call
             returned 401 and the caller cleared STEAMPASS_TOKEN.

        Steampass.gg started requiring an email verification code for
        password logins, AND rate-limits / IP-bans accounts that hit
        /auth/login too often. Caching the bearer token means we
        basically never hit /auth/login from the bot, and the user only
        needs to refresh it manually when steampass invalidates the
        session (typically weeks/months).
        """
        cached = (os.environ.get("STEAMPASS_TOKEN") or "").strip()
        if cached:
            self.token = cached
            self.session.headers["Authorization"] = f"Bearer {self.token}"
            log("Steampass: using cached bearer token (skipping /auth/login)")
            return

        log("Steampass: no cached token — falling back to /auth/login (rate-limited!)")
        resp = _steampass_request(self.session.post,
            f"{STEAMPASS_API}/auth/login",
            json={"login": self.login, "password": self.password})
        # Don't raise_for_status — surface the body so staff sees WHY it
        # failed (422 = email code required, 429 = rate-limited, 403 = IP ban).
        if resp.status_code >= 400:
            body = resp.text[:400]
            raise RuntimeError(
                f"Steampass /auth/login returned HTTP {resp.status_code}.\n"
                f"Response: {body}\n\n"
                f"Most likely steampass is asking for an email verification code or has IP-banned\n"
                f"the bot. Fix: log in via the web UI yourself, copy the bearer token from\n"
                f"DevTools (Network → any API request → Authorization header), then run\n"
                f"`/setsteampass <token>` in Discord. The bot will skip /auth/login from then on."
            )
        data = resp.json()
        self.token = data.get("data", {}).get("token")
        if not self.token:
            raise RuntimeError(f"Steampass login succeeded but no token in response: {data}")
        self.session.headers["Authorization"] = f"Bearer {self.token}"
        log("Steampass: authenticated via password login")

    def get_steam_credentials(self, product_uuid):
        """Get Steam username + password for a product."""
        resp = _steampass_request(self.session.get,
            f"{STEAMPASS_API}/profile/product-credentials/{product_uuid}",
            params={"account_platform": 1},
        )
        if not resp.ok:
            # Surface the actual API error message (credits exhausted, etc.)
            log(f"Steampass credentials API {resp.status_code} for UUID {product_uuid}: {resp.text[:500]}")
            resp.raise_for_status()
        raw = resp.json()
        data = raw.get("data", {})
        # Log the response structure so we can detect API format changes
        log(f"Steampass: raw response keys={list(raw.keys())}, "
            f"data keys={list(data.keys())}")
        steam = data.get("steam", data)  # Handle both nested and flat responses
        if steam is not data:
            log(f"Steampass: using nested 'steam' object, keys={list(steam.keys())}")
        login = steam.get("login")
        password = steam.get("password")
        guarded = steam.get("guarded", True)
        if not login or not password:
            log(f"Steampass: MISSING credentials! login={'set' if login else 'EMPTY'}, "
                f"password={'set' if password else 'EMPTY'}, "
                f"available keys={list(steam.keys())}")
            raise RuntimeError(f"No Steam credentials returned for {product_uuid}")
        # Masked diagnostic: show username + password shape without
        # revealing the actual password. Enough to tell if it's
        # truncated, has weird chars, or is from the wrong account.
        pw_preview = f"{password[0]}{'*' * (len(password) - 2)}{password[-1]}" if len(password) > 2 else "***"
        log(f"Steampass: got credentials (login={login}, "
            f"pw_len={len(password)}, pw_preview={pw_preview}, "
            f"guarded={guarded})")
        return login, password, guarded

    def get_guard_code(self, product_uuid):
        """Request a Steam Guard authorization code."""
        resp = _steampass_request(self.session.post,
            f"{STEAMPASS_API}/email/code/main",
            json={"uuid": product_uuid},
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
def _extract_refresh_token(client):
    """Pull a long-lived refresh/login token out of a logged-in SteamClient.

    The ValvePython steam library has moved this around across versions —
    sometimes it's `client.refresh_token`, sometimes `client.login_key`
    (older Steam Guard remember-me mechanism), sometimes nested under an
    internal auth object. Best-effort: try several known attribute paths
    and return whatever non-empty string we find, or None.

    Returning None just means Phase 2 (refresh-token reuse) is skipped
    for this account; cached creds (Phase 1) still kick in for the next
    gen, so we still beat the always-hit-steampass baseline.
    """
    for attr in ("refresh_token", "login_key"):
        v = getattr(client, attr, None)
        if v:
            return str(v)
    for parent_attr in ("authentication", "_auth", "session"):
        parent = getattr(client, parent_attr, None)
        if parent is None:
            continue
        for child_attr in ("refresh_token", "access_token", "login_key"):
            v = getattr(parent, child_attr, None)
            if v:
                return str(v)
    return None


def _login_with_refresh_token(client, username, refresh_token):
    """Attempt Steam CM login using a saved refresh_token (skip
    username+password+guard code entirely). Returns EResult on attempt;
    raises if no library path supports it.

    Library API moved several times between steam[client] versions; we
    try the documented shapes in order and stop at the first that doesn't
    immediately throw AttributeError. If all paths throw, the caller
    falls back to cold-start login.
    """
    from steam.enums import EResult

    # Shape A: direct kwarg on client.login() — newer steam lib versions
    # accept access_token / login_key as alternatives to password.
    for kwarg in ("access_token", "login_key", "auth_token"):
        try:
            result = client.login(username=username, **{kwarg: refresh_token})
            log(f"Steam: tried login({kwarg}=...) → {result}")
            return result
        except TypeError:
            # Library doesn't accept that kwarg; try the next.
            continue
        except Exception as e:
            log(f"Steam: login({kwarg}=...) threw {type(e).__name__}: {e}")
            continue

    # Shape B: WebAuth → access_token → client.login. This is the modern
    # Steam Authentication path. Defensive about which renewal method
    # the installed library version exposes.
    try:
        from steam.webauth import WebAuth
        wa = WebAuth(username)
        wa.refresh_token = refresh_token
        renewed = False
        for method_name in ("renew_refresh_token", "_update_login_token", "refresh_session"):
            method = getattr(wa, method_name, None)
            if callable(method):
                try:
                    method()
                    renewed = True
                    break
                except Exception as e:
                    log(f"Steam: WebAuth.{method_name}() threw {type(e).__name__}: {e}")
                    continue
        if renewed:
            access = getattr(wa, "access_token", None)
            if access:
                try:
                    return client.login(username=username, access_token=access)
                except TypeError:
                    pass
    except ImportError:
        log("Steam: steam.webauth not importable — Shape B unavailable")
    except Exception as e:
        log(f"Steam: WebAuth path threw {type(e).__name__}: {e}")

    raise RuntimeError(
        "No refresh-token login path is supported by this steam[client] "
        "library version. Cold-start fallback required."
    )


def _new_auth_login(client, username, password, guard_code):
    """Authenticate via Steam's modern CAuthentication service (2023+).

    Uses the HTTP IAuthenticationService to perform the OAuth2-like flow
    without relying on the CM connection (which drops unauthenticated
    UMs on some servers/versions):
      1. GetPasswordRSAPublicKey → get RSA key for the account
      2. RSA-encrypt the password
      3. BeginAuthSessionViaCredentials → submit encrypted password
      4. UpdateAuthSessionWithSteamGuardCode → submit guard code
      5. PollAuthSessionStatus → get refresh_token + access_token
      6. Use access_token to finalize CM login

    Returns True on success, raises on fatal errors. The caller should
    catch exceptions and fall back to the legacy ClientLogon path.
    """
    from steam.enums import EResult
    try:
        from steam.enums import EMsg
    except ImportError:
        try:
            from steam.enums.emsg import EMsg
        except ImportError:
            # Last resort: use raw integer for ClientLogon
            class _EMsg:
                ClientLogon = 5514
                ClientLogOnResponse = 751
            EMsg = _EMsg
    from steam.core.msg import MsgProto
    from steam.steamid import SteamID
    import base64
    import requests
    import time

    try:
        from Cryptodome.PublicKey import RSA as CryptoRSA
        from Cryptodome.Cipher import PKCS1_v1_5
    except ImportError:
        from Crypto.PublicKey import RSA as CryptoRSA
        from Crypto.Cipher import PKCS1_v1_5

    # ── Step 1: Get RSA public key for this account ──
    log("Steam [NewAuth]: requesting RSA public key via HTTP...")
    rsa_url = "https://api.steampowered.com/IAuthenticationService/GetPasswordRSAPublicKey/v1"
    resp = requests.get(rsa_url, params={"account_name": username}, timeout=15)
    if not resp.ok:
        raise RuntimeError(f"GetPasswordRSAPublicKey HTTP failed: {resp.status_code} {resp.text[:100]}")
    
    rsa_data = resp.json().get("response", {})
    mod_hex = rsa_data.get("publickey_mod")
    exp_hex = rsa_data.get("publickey_exp")
    timestamp = rsa_data.get("timestamp")
    
    if not mod_hex or not exp_hex:
        raise RuntimeError(f"GetPasswordRSAPublicKey invalid response: {rsa_data}")

    log(f"Steam [NewAuth]: got RSA key (timestamp={timestamp})")

    # ── Step 2: RSA-encrypt the password ──
    mod = int(mod_hex, 16)
    exp = int(exp_hex, 16)
    rsa_key = CryptoRSA.construct((mod, exp))
    cipher = PKCS1_v1_5.new(rsa_key)
    encrypted_password = base64.b64encode(
        cipher.encrypt(password.encode("utf-8"))
    ).decode("ascii")

    # ── Step 3: BeginAuthSessionViaCredentials ──
    log("Steam [NewAuth]: BeginAuthSessionViaCredentials via HTTP...")
    begin_url = "https://api.steampowered.com/IAuthenticationService/BeginAuthSessionViaCredentials/v1"
    resp = requests.post(begin_url, data={
        "device_friendly_name": "GameGen Bot",
        "account_name": username,
        "encrypted_password": encrypted_password,
        "encryption_timestamp": timestamp,
        "remember_login": "true",
        "platform_type": 1,  # k_EAuthTokenPlatformType_SteamClient
        "website_id": "Client"
    }, timeout=15)
    
    if not resp.ok:
        raise RuntimeError(f"BeginAuthSessionViaCredentials HTTP failed: {resp.status_code} {resp.text[:100]}")
    
    begin_data = resp.json().get("response", {})
    client_id = begin_data.get("client_id")
    request_id = begin_data.get("request_id")
    steamid = begin_data.get("steamid")
    interval = begin_data.get("interval", 5)
    allowed = begin_data.get("allowed_confirmations", [])

    if not client_id:
        raise RuntimeError(f"BeginAuthSessionViaCredentials invalid response: {begin_data}")

    confirm_types = [f"{ac.get('confirmation_type')}({ac.get('associated_message')})" for ac in allowed]
    log(f"Steam [NewAuth]: session started (steamid={steamid}, allowed_confirmations={confirm_types})")

    # ── Step 4: Submit guard code ──
    code_type = 2  # default to email code (steampass uses email)
    for ac in allowed:
        if ac.get("confirmation_type") == 3:
            code_type = 3  # TOTP takes priority if offered
            break
        elif ac.get("confirmation_type") == 2:
            code_type = 2
            break

    log(f"Steam [NewAuth]: submitting guard code (type={'TOTP' if code_type == 3 else 'email'})...")
    update_url = "https://api.steampowered.com/IAuthenticationService/UpdateAuthSessionWithSteamGuardCode/v1"
    resp = requests.post(update_url, data={
        "client_id": client_id,
        "steamid": steamid,
        "code": guard_code,
        "code_type": code_type,
    }, timeout=15)
    
    if not resp.ok:
        raise RuntimeError(f"UpdateAuthSessionWithSteamGuardCode HTTP failed: {resp.status_code} {resp.text[:100]}")
    
    log("Steam [NewAuth]: guard code accepted!")

    # ── Step 5: Poll for tokens ──
    log("Steam [NewAuth]: polling for auth session status...")
    access_token = None
    refresh_token_new = None
    poll_url = "https://api.steampowered.com/IAuthenticationService/PollAuthSessionStatus/v1"
    
    for attempt in range(10):
        time.sleep(interval)
        resp = requests.post(poll_url, data={
            "client_id": client_id,
            "request_id": request_id,
        }, timeout=15)
        
        if not resp.ok:
            log(f"Steam [NewAuth]: poll HTTP failed {resp.status_code} {resp.text[:100]}")
            continue
            
        poll_data = resp.json().get("response", {})
        access_token = poll_data.get("access_token")
        refresh_token_new = poll_data.get("refresh_token")

        if access_token:
            log(f"Steam [NewAuth]: got access_token (len={len(access_token)}), "
                f"refresh_token={'yes' if refresh_token_new else 'no'}")
            break
            
        if poll_data.get("new_client_id"):
            client_id = poll_data.get("new_client_id")
    else:
        raise RuntimeError("PollAuthSessionStatus: no tokens after 10 attempts")

    if not access_token:
        raise RuntimeError("PollAuthSessionStatus returned empty access_token")

    # ── Step 6: Finalize CM login with access_token ──
    log("Steam [NewAuth]: finalizing CM login with access_token...")
    msg = MsgProto(EMsg.ClientLogon)
    msg.header.steamid = SteamID(type='Individual', universe='Public')
    msg.body.protocol_version = 65580
    msg.body.client_os_type = -203  # EOSType.Windows10
    msg.body.client_language = "english"
    msg.body.should_remember_password = True
    msg.body.supports_rate_limit_response = True
    msg.body.account_name = username
    msg.body.access_token = access_token

    client.send(msg)
    resp_msg = client.wait_msg(EMsg.ClientLogOnResponse, timeout=30)

    if resp_msg and resp_msg.body.eresult == EResult.OK:
        client.sleep(0.5)
        log("Steam [NewAuth]: CM login succeeded!")
        # Stash the refresh_token so _extract_refresh_token() can find it
        if refresh_token_new:
            client.refresh_token = refresh_token_new
        return True
    else:
        eresult = EResult(resp_msg.body.eresult) if resp_msg else "timeout"
        raise RuntimeError(f"CM ClientLogon with access_token failed: {eresult}")


def get_encrypted_ticket_headless(app_id, steam_login, steam_password, guard_code,
                                  refresh_token=None):
    """Connect to Steam CM servers headlessly and get an encrypted app ticket.

    Uses ValvePython's steam library — no Steam client needed.
    Tested and confirmed working with steampass.gg TOTP guard codes.

    `refresh_token` (optional): if non-empty, try a token-based login
    first to bypass the full credentials+guard dance (and therefore
    skip the steampass /email/code/main call). On failure for any
    reason — token expired, library API mismatch, Steam rejected it —
    falls through to the standard credentials path silently. The caller
    can pass guard_code=None when refresh_token is set; if the token
    path fails the function will raise because there's no guard code
    to fall back with.

    Returns (ticket_bytes, steam_id, refresh_token_for_next_time). The
    third element is what _extract_refresh_token() pulled off the
    SteamClient after login — possibly the same value the caller
    passed in, possibly a freshly rotated one, possibly None if the
    library version doesn't expose it.
    """
    from steam.client import SteamClient
    from steam.enums import EResult

    app_id = int(app_id)
    client = SteamClient()

    log("Steam: connecting to CM servers...")
    client.connect()
    if not client.connected:
        raise RuntimeError("Steam: failed to connect to CM servers")
    log("Steam: connected!")

    logged_in_via = None

    # ── Phase 2: try refresh-token login if one was provided ──
    if refresh_token:
        log("Steam: attempting refresh-token login (zero-steampass path)...")
        try:
            result = _login_with_refresh_token(client, steam_login, refresh_token)
            if result == EResult.OK:
                log("Steam: refresh-token login succeeded — no steampass calls needed")
                logged_in_via = "refresh_token"
            else:
                log(f"Steam: refresh-token login returned {result} — falling back to creds")
        except Exception as e:
            log(f"Steam: refresh-token path unavailable ({e}) — falling back to creds")

    # ── Cold-start path: credentials + guard code (steampass-issued) ──
    if logged_in_via is None:
        if not guard_code:
            client.disconnect()
            raise RuntimeError(
                "Refresh-token login failed and no guard_code was supplied for "
                "cold-start fallback. Caller must request a guard code from "
                "steampass before retrying."
            )
        log("Steam: authenticating with credentials + guard code...")

        # ── NEW AUTH FLOW (CAuthentication service) ──
        # Valve deprecated the old ClientLogon CM message in 2023. Accounts
        # migrated to the new auth system reject the old method with
        # EResult.InvalidPassword (5) even with correct credentials. The
        # new flow uses IAuthenticationService Unified Messages:
        #   1. GetPasswordRSAPublicKey → RSA-encrypt the password
        #   2. BeginAuthSessionViaCredentials → submit encrypted password
        #   3. UpdateAuthSessionWithSteamGuardCode → submit guard code
        #   4. PollAuthSessionStatus → get refresh_token + access_token
        #   5. Use access_token to finalize CM login
        new_auth_ok = False
        try:
            new_auth_ok = _new_auth_login(client, steam_login, steam_password, guard_code)
        except Exception as e:
            log(f"Steam: new CAuthentication flow failed ({type(e).__name__}: {e}), "
                "falling back to legacy ClientLogon...")

        if new_auth_ok:
            logged_in_via = "credentials_new_auth"
        else:
            # ── LEGACY FALLBACK: old ClientLogon CM message ──
            # Try both two_factor_code and auth_code in case the account
            # still supports the old protocol.
            log("Steam: trying legacy login (two_factor_code)...")
            result = client.login(
                username=steam_login,
                password=steam_password,
                two_factor_code=guard_code,
            )
            if result != EResult.OK:
                log(f"Steam: legacy two_factor_code returned {result}, "
                    "trying auth_code...")
                client.disconnect()
                client.connect()
                if not client.connected:
                    raise RuntimeError("Steam: failed to reconnect for auth_code retry")
                result = client.login(
                    username=steam_login,
                    password=steam_password,
                    auth_code=guard_code,
                )
            if result != EResult.OK:
                client.disconnect()
                raise RuntimeError(f"Steam: login failed with result: {result}")
            logged_in_via = "credentials"

    steam_id = str(client.steam_id.as_64)
    log(f"Steam: logged in via {logged_in_via} (SteamID: {steam_id})")

    # Pull a refresh token off the live session so the next gen can skip
    # the steampass dance entirely. May return None on older library
    # versions — that's not fatal, we still wrote the cached creds
    # to the sidecar for the cached-creds fast path next time.
    next_refresh_token = _extract_refresh_token(client)
    if next_refresh_token:
        log(f"Steam: captured refresh_token for cache (len {len(next_refresh_token)})")
    else:
        log("Steam: no refresh_token exposed by this library version (cached creds will still help)")

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
    return ticket_bytes, steam_id, next_refresh_token


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

    # ── DLCs ──
    # Enumerate DLCs from Steam's appdetails endpoint (no API key needed,
    # public store data). Format Goldberg expects:
    #   [app::dlcs]
    #   unlock_all = 0
    #   <dlc_appid> = <dlc name>
    # When `unlock_all = 0` and DLCs are explicitly listed, Goldberg only
    # returns "owned" for the listed IDs — same behavior the old
    # _Template/<appid>/configs.app.ini files provided manually.
    dlc_lines = ["[app::dlcs]", "unlock_all = 0"]
    try:
        r = requests.get(
            f"https://store.steampowered.com/api/appdetails",
            params={"appids": app_id, "filters": "basic"},
            timeout=10,
        )
        d = (r.json().get(str(app_id), {}) or {}).get("data", {})
        for dlc_id in (d.get("dlc") or []):
            # Per-DLC name fetch is rate-limited (5 req/sec) and we want to
            # avoid blowing the API budget on every gen — list IDs without
            # names. Goldberg honors unlock-by-ID even when name is empty.
            dlc_lines.append(f"{int(dlc_id)} =")
    except Exception as e:
        log(f"DLC enumeration failed (non-fatal, shipping with empty DLC list): {e}")
    (ss / "configs.app.ini").write_text("\n".join(dlc_lines) + "\n")

    # ── Depots ──
    try:
        r = requests.get(
            f"https://api.steamcmd.net/v1/info/{app_id}", timeout=8)
        info = r.json().get("data", {}).get(str(app_id), {})
        depots = info.get("depots", {})
        depot_ids = [k for k in depots if k.isdigit()]
        if depot_ids:
            (ss / "depots.txt").write_text("\n".join(depot_ids))
    except Exception:
        pass

    (ss / "supported_languages.txt").write_text(
        "english\njapanese\nbrazilian\nschinese\ntchinese\n")

    # ── Steam interfaces ──
    # Goldberg uses steam_interfaces.txt to know which interface versions
    # to expose. Most games are happy with whatever Goldberg picks by
    # default; modern Denuvo titles (especially RE Engine / UE5) want
    # explicit guarantees that specific Get*Interface_* calls succeed.
    # Ship a curated modern superset — covers every version current
    # Goldberg knows about for each interface family. Older versions are
    # included so older games keep working; newer versions cover RE9 /
    # any 2025+ release.
    (ss / "steam_interfaces.txt").write_text(_STEAM_INTERFACES_MODERN)


# Modern Goldberg interface superset — kept here as a module constant
# (rather than per-game template files) so every game in the catalog
# gets the same baseline. Curated from Goldberg's experimental client
# headers + the union of every per-game steam_interfaces.txt that
# previously lived under _Template/.
_STEAM_INTERFACES_MODERN = """STEAMAPPS_INTERFACE_VERSION001
STEAMAPPS_INTERFACE_VERSION002
STEAMAPPS_INTERFACE_VERSION003
STEAMAPPS_INTERFACE_VERSION004
STEAMAPPS_INTERFACE_VERSION005
STEAMAPPS_INTERFACE_VERSION006
STEAMAPPS_INTERFACE_VERSION007
STEAMAPPS_INTERFACE_VERSION008
STEAMAPPLIST_INTERFACE_VERSION001
STEAMAPPTICKET_INTERFACE_VERSION001
SteamClient006
SteamClient007
SteamClient008
SteamClient009
SteamClient010
SteamClient011
SteamClient012
SteamClient013
SteamClient014
SteamClient015
SteamClient016
SteamClient017
SteamClient018
SteamClient019
SteamClient020
SteamClient021
SteamController003
SteamController004
SteamController005
SteamController006
SteamController007
SteamController008
SteamFriends001
SteamFriends002
SteamFriends003
SteamFriends004
SteamFriends005
SteamFriends006
SteamFriends007
SteamFriends008
SteamFriends009
SteamFriends010
SteamFriends011
SteamFriends012
SteamFriends013
SteamFriends014
SteamFriends015
SteamFriends016
SteamFriends017
SteamFriends018
SteamGameServerStats001
SteamGameServer010
SteamGameServer011
SteamGameServer012
SteamGameServer013
SteamGameServer014
SteamGameServer015
STEAMHTMLSURFACE_INTERFACE_VERSION_001
STEAMHTMLSURFACE_INTERFACE_VERSION_002
STEAMHTMLSURFACE_INTERFACE_VERSION_003
STEAMHTMLSURFACE_INTERFACE_VERSION_004
STEAMHTMLSURFACE_INTERFACE_VERSION_005
STEAMHTTP_INTERFACE_VERSION001
STEAMHTTP_INTERFACE_VERSION002
STEAMHTTP_INTERFACE_VERSION003
SteamInput001
SteamInput002
SteamInput003
SteamInput004
SteamInput005
SteamInput006
STEAMINVENTORY_INTERFACE_V001
STEAMINVENTORY_INTERFACE_V002
STEAMINVENTORY_INTERFACE_V003
SteamMatchMakingServers001
SteamMatchMakingServers002
SteamMatchMaking001
SteamMatchMaking002
SteamMatchMaking003
SteamMatchMaking004
SteamMatchMaking005
SteamMatchMaking006
SteamMatchMaking007
SteamMatchMaking008
SteamMatchMaking009
SteamMatchGameSearch001
SteamParties001
SteamParties002
STEAMMUSIC_INTERFACE_VERSION001
STEAMMUSICREMOTE_INTERFACE_VERSION001
SteamNetworkingMessages001
SteamNetworkingMessages002
SteamNetworkingSockets001
SteamNetworkingSockets002
SteamNetworkingSockets003
SteamNetworkingSockets004
SteamNetworkingSockets006
SteamNetworkingSockets008
SteamNetworkingSockets009
SteamNetworkingSockets010
SteamNetworkingSockets011
SteamNetworkingSockets012
SteamNetworkingUtils001
SteamNetworkingUtils002
SteamNetworkingUtils003
SteamNetworkingUtils004
SteamNetworking001
SteamNetworking002
SteamNetworking003
SteamNetworking004
SteamNetworking005
SteamNetworking006
STEAMPARENTALSETTINGS_INTERFACE_VERSION001
STEAMREMOTEPLAY_INTERFACE_VERSION001
STEAMREMOTEPLAY_INTERFACE_VERSION002
STEAMREMOTEPLAY_INTERFACE_VERSION003
STEAMREMOTESTORAGE_INTERFACE_VERSION001
STEAMREMOTESTORAGE_INTERFACE_VERSION002
STEAMREMOTESTORAGE_INTERFACE_VERSION003
STEAMREMOTESTORAGE_INTERFACE_VERSION004
STEAMREMOTESTORAGE_INTERFACE_VERSION005
STEAMREMOTESTORAGE_INTERFACE_VERSION006
STEAMREMOTESTORAGE_INTERFACE_VERSION007
STEAMREMOTESTORAGE_INTERFACE_VERSION008
STEAMREMOTESTORAGE_INTERFACE_VERSION009
STEAMREMOTESTORAGE_INTERFACE_VERSION010
STEAMREMOTESTORAGE_INTERFACE_VERSION011
STEAMREMOTESTORAGE_INTERFACE_VERSION012
STEAMREMOTESTORAGE_INTERFACE_VERSION013
STEAMREMOTESTORAGE_INTERFACE_VERSION014
STEAMREMOTESTORAGE_INTERFACE_VERSION015
STEAMREMOTESTORAGE_INTERFACE_VERSION016
STEAMSCREENSHOTS_INTERFACE_VERSION001
STEAMSCREENSHOTS_INTERFACE_VERSION002
STEAMSCREENSHOTS_INTERFACE_VERSION003
STEAMTIMELINE_INTERFACE_V001
STEAMTIMELINE_INTERFACE_V002
STEAMTIMELINE_INTERFACE_V003
STEAMTIMELINE_INTERFACE_V004
STEAMUGC_INTERFACE_VERSION001
STEAMUGC_INTERFACE_VERSION002
STEAMUGC_INTERFACE_VERSION003
STEAMUGC_INTERFACE_VERSION004
STEAMUGC_INTERFACE_VERSION005
STEAMUGC_INTERFACE_VERSION006
STEAMUGC_INTERFACE_VERSION007
STEAMUGC_INTERFACE_VERSION008
STEAMUGC_INTERFACE_VERSION009
STEAMUGC_INTERFACE_VERSION010
STEAMUGC_INTERFACE_VERSION011
STEAMUGC_INTERFACE_VERSION012
STEAMUGC_INTERFACE_VERSION013
STEAMUGC_INTERFACE_VERSION014
STEAMUGC_INTERFACE_VERSION015
STEAMUGC_INTERFACE_VERSION016
STEAMUGC_INTERFACE_VERSION017
STEAMUGC_INTERFACE_VERSION018
STEAMUGC_INTERFACE_VERSION019
STEAMUGC_INTERFACE_VERSION020
STEAMUGC_INTERFACE_VERSION021
SteamUser004
SteamUser005
SteamUser006
SteamUser007
SteamUser008
SteamUser009
SteamUser010
SteamUser011
SteamUser012
SteamUser013
SteamUser014
SteamUser015
SteamUser016
SteamUser017
SteamUser018
SteamUser019
SteamUser020
SteamUser021
SteamUser022
SteamUser023
STEAMUSERSTATS_INTERFACE_VERSION001
STEAMUSERSTATS_INTERFACE_VERSION002
STEAMUSERSTATS_INTERFACE_VERSION003
STEAMUSERSTATS_INTERFACE_VERSION004
STEAMUSERSTATS_INTERFACE_VERSION005
STEAMUSERSTATS_INTERFACE_VERSION006
STEAMUSERSTATS_INTERFACE_VERSION007
STEAMUSERSTATS_INTERFACE_VERSION008
STEAMUSERSTATS_INTERFACE_VERSION009
STEAMUSERSTATS_INTERFACE_VERSION010
STEAMUSERSTATS_INTERFACE_VERSION011
STEAMUSERSTATS_INTERFACE_VERSION012
STEAMUSERSTATS_INTERFACE_VERSION013
SteamUtils001
SteamUtils002
SteamUtils003
SteamUtils004
SteamUtils005
SteamUtils006
SteamUtils007
SteamUtils008
SteamUtils009
SteamUtils010
STEAMVIDEO_INTERFACE_V001
STEAMVIDEO_INTERFACE_V002
STEAMVIDEO_INTERFACE_V003
STEAMVIDEO_INTERFACE_V004
STEAMVIDEO_INTERFACE_V005
STEAMVIDEO_INTERFACE_V006
STEAMVIDEO_INTERFACE_V007
STEAMUNIFIEDMESSAGES_INTERFACE_VERSION001
SteamMasterServerUpdater001
SteamGameCoordinator001
"""


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

        # ── Cached session lookup ──
        # Node looks up the most recent SteamSession row for this UUID
        # before spawning Python and passes whatever's there via env.
        # All three are optional — if a field is empty/missing we just
        # skip that fast path and fall through to the next.
        cached_login = (os.environ.get("CACHED_STEAM_LOGIN") or "").strip()
        cached_password = (os.environ.get("CACHED_STEAM_PASSWORD") or "").strip()
        cached_refresh_token = (os.environ.get("CACHED_STEAM_REFRESH_TOKEN") or "").strip()
        cached_guarded = (os.environ.get("CACHED_STEAM_GUARDED") or "").strip().lower() == "true"
        if cached_login:
            log(f"Found cached Steam session for this UUID (login={cached_login}, "
                f"refresh_token={'yes' if cached_refresh_token else 'no'})")

        steam_login = None
        steam_password = None
        guarded = True
        guard_code = None
        sp = None  # lazy — only construct if we actually need to hit steampass
        session_source = None  # what worked: refresh_token | cached_creds | steampass

        # ── Phase 2: try refresh-token reuse (zero steampass calls) ──
        if cached_login and cached_refresh_token:
            log("Attempting Steam CM login via cached refresh_token "
                "(no steampass calls)...")
            try:
                ticket_bytes, steam_id, new_refresh_token = get_encrypted_ticket_headless(
                    app_id,
                    cached_login,
                    cached_password,  # may be empty — fine, refresh-token path doesn't need it
                    None,             # no guard code needed
                    refresh_token=cached_refresh_token,
                )
                steam_login = cached_login
                steam_password = cached_password
                guarded = cached_guarded
                session_source = "refresh_token"
                log("Refresh-token login succeeded — skipped steampass entirely")
            except Exception as e:
                log(f"Refresh-token path failed ({e}) — falling back to cached creds / steampass")
                # Clear the new_refresh_token from any previous attempt
                # so we don't accidentally write a stale one back to DB
                new_refresh_token = None
                ticket_bytes = None
                steam_id = None

        # ── Phase 1: try cached creds (skip /profile/product-credentials) ──
        if session_source is None and cached_login and cached_password:
            log("Using cached Steam credentials — skipping steampass "
                "/profile/product-credentials call")
            steam_login = cached_login
            steam_password = cached_password
            guarded = cached_guarded
            if guarded:
                # Still need a fresh guard code from steampass — that's
                # the only call this path makes.
                log("Requesting Steam Guard code (only steampass call needed)...")
                sp = SteampassClient(sp_login, sp_password)
                sp.authenticate()
                guard_code = sp.get_guard_code(steampass_uuid)
            try:
                ticket_bytes, steam_id, new_refresh_token = get_encrypted_ticket_headless(
                    app_id, steam_login, steam_password, guard_code,
                )
                session_source = "cached_creds"
                log("Cached-creds login succeeded — 1 steampass call used "
                    "(/email/code/main only)")
            except Exception as e:
                log(f"Cached-creds path failed ({e}) — falling back to full steampass flow")
                new_refresh_token = None
                ticket_bytes = None
                steam_id = None

        # ── Cold start: full steampass flow (last resort) ──
        if session_source is None:
            log("No cached session usable — running full steampass flow "
                "(/profile/product-credentials + /email/code/main)")
            if sp is None:
                sp = SteampassClient(sp_login, sp_password)
                sp.authenticate()
            steam_login, steam_password, guarded = sp.get_steam_credentials(steampass_uuid)
            guard_code = None
            if guarded:
                log("Requesting Steam Guard code...")
                guard_code = sp.get_guard_code(steampass_uuid)

            log("Connecting to Steam servers (headless)...")
            try:
                ticket_bytes, steam_id, new_refresh_token = get_encrypted_ticket_headless(
                    app_id, steam_login, steam_password, guard_code,
                )
            except RuntimeError as e:
                log(f"ERROR: {e}")
                sys.exit(1)
            session_source = "steampass"

        token_b64 = base64.b64encode(ticket_bytes).decode()
        log(f"Token generated (SteamID: {steam_id}, source: {session_source})")

        # Stash session metadata for Node to read out of the sidecar.
        # Defined module-globally because the sidecar is written down in
        # build_thin_zip after we return — easiest to pin to a closure.
        os.environ["_GAMEGEN_SESSION_SOURCE"] = session_source or ""
        os.environ["_GAMEGEN_NEW_REFRESH_TOKEN"] = new_refresh_token or ""
        os.environ["_GAMEGEN_NEW_STEAM_LOGIN"] = steam_login or ""
        os.environ["_GAMEGEN_NEW_STEAM_PASSWORD"] = steam_password or ""
        os.environ["_GAMEGEN_NEW_STEAM_ID"] = steam_id or ""
        os.environ["_GAMEGEN_NEW_STEAM_GUARDED"] = "true" if guarded else "false"

    # ── Step 4: Build output zip ──
    # Two paths:
    #   1. PUBLIC_URL set → thin zip + payload manifest (installer downloads
    #      Goldberg binaries from the bot's HTTP endpoint on demand).
    #      Smallest user-facing zip (~9 MB).
    #   2. PUBLIC_URL not set → multi-mode embedded zip (both payloads
    #      bundled, ~50 MB) as a self-contained fallback.
    #
    # The third "GAMEGEN_LEGACY_OUTPUT=1" branch is gone — it copied a
    # per-game folder structure from _Template/<appid>/ and then layered
    # GBE files on top, but _Template/ no longer exists (everything is
    # generated dynamically now). If you need single-mode output, use the
    # thin zip path and /setmode'd game so only one mode actually gets
    # downloaded.
    base_url = _public_base_url()
    pu = os.environ.get("PUBLIC_URL", "")
    rd = os.environ.get("RAILWAY_PUBLIC_DOMAIN", "")
    log(f"Routing decision: PUBLIC_URL='{pu}' RAILWAY_PUBLIC_DOMAIN='{rd}' resolved_base_url='{base_url}'")
    if base_url:
        log(f"→ build_thin_zip (manifest mode, ~9 MB)")
        zip_path = build_thin_zip(
            out, app_id, game_name, generation_mode, token_b64, steam_id, fake_mode, base_url
        )
    else:
        log("→ build_multi_mode_zip (embedded fallback, ~50 MB) — PUBLIC_URL not set")
        zip_path = build_multi_mode_zip(
            out, app_id, game_name, generation_mode, token_b64, steam_id, fake_mode
        )
    print(zip_path)
    return



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
