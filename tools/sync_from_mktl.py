"""
sync_from_mktl.py - Sync DLLs from MKTL into the bot's template system.

When MKTL gets updated, its bundled Steam-emu DLLs at
  C:\\Program Files\\MKTL\\st-up\\dependency\\{coldloader,steam_api}\\*.dll
may change.

DEFAULT (safe) behavior:
  - Hashes every DLL MKTL ships
  - Adds any NEW hash to _Template/_dll_variants/<stem>.<hash>.dll
  - Reports which templates currently use OLDER variants of the same DLL filename
  - DOES NOT modify any template manifest unless you opt in
  - DOES NOT overwrite _Core/ unless you opt in

Different games legitimately use different DLL variants — e.g. some games need
the 17 MB real steamclient64.dll, some need the 116 KB Goldberg stub. Blanket
"update everything to MKTL's version" can break games. Make those swaps
deliberately, per template, with --update-manifests.

Usage:
  python tools/sync_from_mktl.py
      Add new MKTL variants to the pool, show what's outdated, don't modify
      manifests or _Core. Run this after every MKTL update.

  python tools/sync_from_mktl.py --update-core
      Also update _Core/<name>.dll to match MKTL (use sparingly — _Core is
      what the bot's auto-gen path uses for templates that don't have a
      manifest).

  python tools/sync_from_mktl.py --update-manifests
      Interactively offer to swap each template manifest entry to the new
      variant. Asks y/N per template. Use this when you've verified the new
      version works for all affected games.

  python tools/sync_from_mktl.py --skip <name.dll>  (repeatable)
      Skip a DLL entirely. Defaults skip coldloader.dll and steam_api64.dll
      because you've intentionally chosen non-MKTL versions for those.

  --dry-run        preview without writing
  --yes            auto-confirm manifest updates (skip prompts)
"""

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

MKTL_ROOT      = Path(r"C:/Program Files/MKTL/st-up/dependency")
MKTL_SOURCES   = [MKTL_ROOT / "coldloader", MKTL_ROOT / "steam_api"]

PROJECT_ROOT   = Path(__file__).resolve().parent.parent
CORE_DIR       = PROJECT_ROOT / "_Core"
TEMPLATE_DIR   = PROJECT_ROOT / "_Template"
VARIANTS_DIR   = TEMPLATE_DIR / "_dll_variants"

# DLLs you've intentionally chosen non-MKTL versions for. Never auto-touched.
DEFAULT_SKIP = {"coldloader.dll", "steam_api64.dll"}


def short_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


def find_mktl_dlls() -> dict:
    """Returns {dll_filename: full_path} from MKTL dependency folders.
    When the same DLL exists in multiple folders, the FIRST occurrence wins
    (coldloader takes priority over steam_api)."""
    found = {}
    for src in MKTL_SOURCES:
        if not src.exists():
            continue
        for dll in src.glob("*.dll"):
            if dll.name not in found:  # first occurrence wins
                found[dll.name] = dll
    return found


def ensure_variant(dll_name, data, dry_run):
    h = short_hash(data)
    stem = Path(dll_name).stem
    variant_name = f"{stem}.{h}.dll"
    target = VARIANTS_DIR / variant_name
    if target.exists():
        return variant_name, False  # already had this exact variant
    if not dry_run:
        VARIANTS_DIR.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return variant_name, True


def update_core(dll_name, src_path, dry_run):
    target = CORE_DIR / dll_name
    new_data = src_path.read_bytes()
    if target.exists() and target.read_bytes() == new_data:
        return False
    if not dry_run:
        target.write_bytes(new_data)
    return True


def scan_manifest_usage(dll_name):
    """Returns list of (appid, rel_path, current_variant) tuples for every
    template manifest entry whose target filename matches dll_name's stem."""
    stem = Path(dll_name).stem
    hits = []
    for appid_dir in sorted(TEMPLATE_DIR.iterdir()):
        if not appid_dir.is_dir() or appid_dir.name == "_dll_variants":
            continue
        manifest_path = appid_dir / "_dll_manifest.json"
        if not manifest_path.exists():
            continue
        manifest = json.loads(manifest_path.read_text())
        for rel, variant in manifest.items():
            if variant.startswith(f"{stem}."):
                hits.append((appid_dir.name, rel, variant))
    return hits


def update_manifests_interactive(dll_name, new_variant, dry_run, yes):
    stem = Path(dll_name).stem
    updated = 0
    for appid_dir in sorted(TEMPLATE_DIR.iterdir()):
        if not appid_dir.is_dir() or appid_dir.name == "_dll_variants":
            continue
        manifest_path = appid_dir / "_dll_manifest.json"
        if not manifest_path.exists():
            continue
        manifest = json.loads(manifest_path.read_text())
        changed = False
        for rel, variant in list(manifest.items()):
            if not variant.startswith(f"{stem}.") or variant == new_variant:
                continue
            prompt = (f"  {appid_dir.name}/{rel}\n"
                      f"     {variant}  --> {new_variant} ? [y/N/a=all/q=quit] ")
            if yes:
                ans = "y"
            else:
                try:
                    ans = input(prompt).strip().lower()
                except EOFError:
                    print("(non-interactive; skipping)")
                    return updated
            if ans == "q":
                return updated
            if ans == "a":
                yes = True
                ans = "y"
            if ans != "y":
                continue
            manifest[rel] = new_variant
            changed = True
            updated += 1
        if changed and not dry_run:
            manifest_path.write_text(json.dumps(manifest, indent=2))
    return updated


def main():
    ap = argparse.ArgumentParser(formatter_class=argparse.RawDescriptionHelpFormatter,
                                 description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--update-core", action="store_true",
                    help="Overwrite _Core/<name>.dll with MKTL's copy.")
    ap.add_argument("--update-manifests", action="store_true",
                    help="Offer to swap each template manifest to point at the new variant.")
    ap.add_argument("--skip", action="append", default=[])
    ap.add_argument("--no-skip-defaults", action="store_true",
                    help="Don't skip coldloader.dll and steam_api64.dll.")
    ap.add_argument("--yes", action="store_true", help="Auto-confirm prompts.")
    args = ap.parse_args()

    skip = set(args.skip)
    if not args.no_skip_defaults:
        skip |= DEFAULT_SKIP

    print(f"MKTL dependency root: {MKTL_ROOT}")
    print(f"Project root:         {PROJECT_ROOT}")
    print(f"Mode:                 {'DRY RUN' if args.dry_run else 'APPLY'}")
    print(f"Skipping:             {sorted(skip)}")
    print(f"Update _Core:         {args.update_core}")
    print(f"Update manifests:     {args.update_manifests}")
    print()

    dlls = find_mktl_dlls()
    if not dlls:
        print(f"No MKTL DLLs found under {MKTL_ROOT}. Is MKTL installed?")
        sys.exit(1)

    summary = []
    for name in sorted(dlls):
        if name in skip:
            print(f"[SKIP] {name}")
            continue

        src = dlls[name]
        data = src.read_bytes()
        new_hash = short_hash(data)
        new_variant_name = f"{Path(name).stem}.{new_hash}.dll"
        print(f"[CHECK] {name}  hash={new_hash}  size={len(data)} bytes")
        print(f"        source: {src}")

        variant_name, added_variant = ensure_variant(name, data, args.dry_run)
        if added_variant:
            print(f"        + added variant: {variant_name}")
        else:
            print(f"        = variant already exists: {variant_name}")

        core_changed = False
        if args.update_core:
            core_changed = update_core(name, src, args.dry_run)
            if core_changed:
                print(f"        + _Core/{name} updated")

        # Always REPORT what manifests use older variants
        all_uses = scan_manifest_usage(name)
        stale = [(a, r, v) for (a, r, v) in all_uses if v != new_variant_name]
        current = [(a, r, v) for (a, r, v) in all_uses if v == new_variant_name]
        if stale:
            print(f"        ! {len(stale)} template(s) still use older {Path(name).stem} variants:")
            for appid, rel, v in stale[:10]:
                print(f"            {appid}: {rel}  uses  {v}")
            if len(stale) > 10:
                print(f"            ... and {len(stale) - 10} more")
        if current:
            print(f"        ok {len(current)} template(s) already on the new variant")

        manifest_updates = 0
        if args.update_manifests and stale:
            print()
            print(f"        --update-manifests: offering to swap each entry")
            manifest_updates = update_manifests_interactive(
                name, new_variant_name, args.dry_run, args.yes)
            if manifest_updates:
                print(f"        + {manifest_updates} manifest(s) updated")

        summary.append((name, added_variant, core_changed, manifest_updates,
                        len(stale), len(current)))
        print()

    print("-" * 60)
    print("Summary")
    print("-" * 60)
    for name, added, core, manifests, stale, current in summary:
        bits = []
        if added: bits.append("new variant added")
        if core: bits.append("_Core updated")
        if manifests: bits.append(f"{manifests} manifest(s) updated")
        if not bits: bits.append("no changes")
        bits.append(f"({current} on new / {stale} on old)")
        print(f"  {name:32s} {'  '.join(bits)}")

    if args.dry_run:
        print("\nDry run complete. Re-run without --dry-run to apply.")
    elif any(s[1] or s[2] or s[3] for s in summary):
        print("\nCommit your changes:")
        print('  git add _Core _Template')
        print('  git commit -m "Sync DLLs from MKTL"')
        print('  git push origin main')


if __name__ == "__main__":
    main()
