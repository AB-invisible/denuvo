# ubisoft-magic

The "magic files" (Uplay/Denuvo crack files) delivered to users in the
two-step Ubisoft flow, one zip per game. Served by the bot's payload server
at `GET /ubisoft/magic/<ubisoftAppId>` and/or attached directly to the
ticket (each is small enough for Discord).

This folder is the **default** magic-files directory — the bot uses it
automatically when `UBISOFT_MAGIC_DIR` is not set (see `resolveMagicDir()`
in `src/utils/ubisoftCatalog.ts`), so hosting works with zero config on
deploy. Set `UBISOFT_MAGIC_DIR` only to override with a volume/other path.

Filenames must match `magicFile` in the catalog (`ubisoftCatalog.ts`).
