# EaTokenService — Linux/Railway

Pure-Python HTTP service for minting EA/Origin Denuvo tokens. Deploy on **Railway**
the same way as `ubisoft-service/` — the Discord bot calls it over HTTP.

No `EAtoken_generator.exe` required. This is a Linux-compatible reimplementation
of the anadius token_generator v1.5.1 HTTP flow.

## Architecture

```
User ticket → Discord bot (Railway) → POST /ea/token → ea-service (Railway/Linux)
```

## Endpoint

```
POST /ea/token
  Header: X-Api-Key: <EA_SERVICE_KEY>
  Body:   { "ticket": "<blob or TICKET|contentId|engine>",
            "contentId": 198235, "engine": "2_1_0" }

200 → { "token": "<gameToken>" }
4xx/5xx → { "error": "...", "code": "LimitExceeded|...", "logs": "…" }

GET /health → { "ok": true, "tool": true, "mode": "python", "configured": true }
```

## Environment (ea-service on Railway)

| Var | Purpose |
|-----|---------|
| `EA_SERVICE_KEY` | **Required.** Shared secret; bot sends as `X-Api-Key`. |
| `EA_LOGIN_REMID` | EA `remid` cookie from Origin Helper / EA app login. |
| `EA_LOGIN_SIGNATURE` | PC signature (`pc_sign`) from Origin Helper / EA app Options. |
| `EA_MACHINE_HASH` | **Required.** `{http://ea.com/license}MachineHash` from your license `.dlf` or token_generator. |
| `EA_LOGIN_SV` | Signature version (`v1` or `v2`). Default `v2`. |
| `EA_APP_VERSION` | EA app version string for User-Agent. Default `13.560.0.6073`. |
| `EA_ACCESS_TOKEN` | Optional: skip login if you have a fresh access token. |
| `PORT` | Listen port. Railway sets this automatically. |

### Getting credentials (one-time, on any PC with EA app)

1. Run `EAtoken_generator.exe` → **Options** → login method → copy `login_remid` + `login_signature`.
2. For `EA_MACHINE_HASH`: use Origin Helper **Get info from license** on a `.dlf` for any owned game,
   or read `{http://ea.com/license}MachineHash` from the XML.

## Deploy on Railway

1. New service → repo root `ea-service`, builder **Dockerfile**.
2. Set env vars above + `EA_SERVICE_KEY`.
3. Generate domain (e.g. `ea-service-production.up.railway.app`).
4. On the **bot** service set:
   ```
   EA_SERVICE_URL=https://<ea-service-domain>
   EA_SERVICE_KEY=<same secret>
   ```

## Bot commands

- `/eagame set` — configure content ID + engine per game
- `/eahealth` — check service reachability
