# EaTokenService — Linux/Railway

Pure-Python HTTP service for minting EA/Origin Denuvo tokens. Deploy on **Railway**
the same way as `ubisoft-service/` — the Discord bot calls it over HTTP.

**No manual `EAtoken_generator.exe` / remid / machine hash setup required** when
you use email/password auto-login (see below).

## Architecture

```
User ticket → Discord bot → POST /ea/token (+ optional email/password)
  → ea-service auto-logins → remid + pc_sign + machine_hash (persisted on volume)
  → GET proxy.novafusion.ea.com/licenses → token
```

## Endpoint

```
POST /ea/token
  Header: X-Api-Key: <EA_SERVICE_KEY>
  Body:   { "ticket": "<blob or TICKET|contentId|engine>",
            "contentId": 16425677, "engine": "0",
            "email": "...", "password": "..." }   // optional — bot sends from /eaaccount

GET /health → { "ok": true, "configured": true, "session_email": "..." }
```

## Environment (ea-service on Railway)

| Var | Purpose |
|-----|---------|
| `EA_SERVICE_KEY` | **Required.** Shared secret; bot sends as `X-Api-Key`. |
| `EA_EMAIL` | Default EA account email (auto-login). |
| `EA_PASSWORD` | Default EA account password. |
| `EA_SESSION_PATH` | Persisted session file. Default `/data/ea_session.json` — **mount a volume at `/data`**. |
| `EA_LOGIN_REMID` | Optional manual override (skip auto-login). |
| `EA_LOGIN_SIGNATURE` | Optional manual `pc_sign` override. |
| `EA_MACHINE_HASH` | Optional manual machine hash override. |
| `PORT` | Railway sets automatically. |

### Auto-login (recommended)

1. Mount a Railway volume on `ea-service` at `/data` (session persistence).
2. Set `EA_EMAIL` + `EA_PASSWORD` **or** use `/eaaccount add` on the bot (bot passes creds per request).
3. On first mint, the service logs into signin.ea.com, saves `remid` + trust cookies to `/data/ea_session.json`.
4. Later mints reuse the session (no manual remid/signature copy).

**First login note:** EA may require a one-time email verification. If mint fails with
`EmailVerificationRequired`, log into EA once in a browser on that account, then retry.

## Deploy on Railway

1. Service root: `ea-service`, builder **Dockerfile**.
2. Volume mount: `/data` (for `ea_session.json`).
3. Set `EA_SERVICE_KEY`, `EA_EMAIL`, `EA_PASSWORD`.
4. On the **bot** service:
   ```
   EA_SERVICE_URL=https://<ea-service-domain>
   EA_SERVICE_KEY=<same secret>
   ```

## Bot commands

- `/eaaccount add` — register EA accounts (rotated, 5/day each)
- `/eagame set` — configure content ID + engine per game
- `/eahealth` — check service + session status
