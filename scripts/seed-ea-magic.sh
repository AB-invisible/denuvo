#!/bin/sh
# Seed EA magic zips onto persistent storage (Railway volume) when missing.
set -eu

DIR="${EA_MAGIC_DIR:-/data/ea-magic}"
FILE="EA SPORTS FC 26 magic files.zip"
DEST="$DIR/$FILE"
SEED_URL="${EA_MAGIC_SEED_URL:-}"

mkdir -p "$DIR"

if [ -f "$DEST" ]; then
  echo "[seed-ea-magic] already present: $DEST"
  exit 0
fi

if [ -z "$SEED_URL" ]; then
  echo "[seed-ea-magic] no seed URL and zip missing at $DEST — upload manually or set EA_MAGIC_SEED_URL"
  exit 0
fi

echo "[seed-ea-magic] downloading to $DEST ..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$SEED_URL" -o "$DEST"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$DEST" "$SEED_URL"
else
  echo "[seed-ea-magic] curl/wget not found"
  exit 0
fi

echo "[seed-ea-magic] done ($(wc -c < "$DEST" 2>/dev/null || echo 0) bytes)"
