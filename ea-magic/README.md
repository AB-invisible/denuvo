# ea-magic

Setup zips for the EA / Origin Denuvo two-step flow.

**Hosted at:** `GET https://<bot-domain>/ea/magic/<contentId>` (payload server on the **denuvo** bot).

## Railway volume (production)

The **denuvo** service has a volume mounted at `/data`. EA zips live in `/data/ea-magic/`.

Env on the bot:
```
EA_MAGIC_DIR=/data/ea-magic
```

### One-time upload (from your PC, after `railway link`)

```powershell
cd path\to\denuvo
railway service link denuvo
tar -cf - -C ea-magic "EA SPORTS FC 26 magic files.zip" | railway ssh -s denuvo -- "mkdir -p /data/ea-magic && tar -xf - -C /data/ea-magic"
```

Verify:
```powershell
railway ssh -s denuvo -- "ls -la /data/ea-magic"
```

Filename must match `eaMagicFile` in `eaCatalog.ts` / `denuvo.json`.

## ea-service vs denuvo

- **denuvo** — Discord bot + hosts magic zips on the volume above.
- **ea-service** — Linux token minter only (`POST /ea/token`). No magic zip volume needed.
