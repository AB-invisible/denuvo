# ea-magic

Setup zips for the EA / Origin Denuvo two-step flow (magic files → `token_req.txt` → `token.ini`).

Served by the bot payload server at `GET /ea/magic/<contentId>` when `PUBLIC_URL` is set,
and linked in the ticket embed. Large zips (>24 MB) are download-only (not Discord attachments).

**Default directory:** this folder is used automatically when `EA_MAGIC_DIR` is not set
(see `resolveMagicDir()` in `src/utils/eaCatalog.ts`).

**Filenames** must match `eaMagicFile` in `eaCatalog.ts` / `denuvo.json`.

## Deploying on Railway

Zips are **not** committed to git (FC 26 is ~377 MB). After deploy, place the file on the bot service:

1. Mount a Railway **volume** at `/app/ea-magic` (or set `EA_MAGIC_DIR` to your mount path), **or**
2. Upload `EA SPORTS FC 26 magic files.zip` into that path via Railway shell / one-off copy.

Default one-time seed URL (Railway env `EA_MAGIC_SEED_URL`):
`https://pixeldrain.com/api/filesystem/DaTaPW8a`
