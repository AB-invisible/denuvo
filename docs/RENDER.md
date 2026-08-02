# Host the Denuvo bot on Render

[Render](https://dashboard.render.com) runs the Discord bot + payload HTTP server 24/7 without keeping your PC on.

## What gets deployed

| Component | Notes |
|-----------|--------|
| **denuvo-bot** | Web service (Docker): Discord bot + `/payload/*` downloads |
| **denuvo-db** | Render Postgres (free tier OK for dev) |

Ubisoft/EA minting still uses your separate **ubisoft-service** / **ea-service** URLs (set `UBISOFT_SERVICE_URL`, `EA_SERVICE_URL` in env).

## One-time setup

### 1. Push this repo to GitHub

Render deploys from Git. Commit and push `render.yaml`, `Dockerfile`, and your latest code.

### 2. Create the stack on Render

1. Open [dashboard.render.com](https://dashboard.render.com)
2. **New → Blueprint**
3. Connect the `denuvo` GitHub repo
4. Apply the blueprint (`render.yaml` creates **denuvo-bot** + **denuvo-db**)

### 3. Add secrets in the dashboard

Generate a paste file on your PC:

```powershell
cd C:\Users\ayoub\Desktop\denuvo
node scripts/generate-render-env.js
```

Open `dist/render-env.txt` and copy values into **denuvo-bot → Environment** (at minimum `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`).

`DATABASE_URL` is linked automatically from the Postgres addon.

### 4. Deploy

Render builds the Docker image (`npm run build` + Python deps) and runs `npm start` (Prisma push + bot).

Health check: `GET /payload/health` → `ok`

Your public URL is shown on the service page, e.g. `https://denuvo-bot.onrender.com`. Render also sets `RENDER_EXTERNAL_URL` — the bot uses it for installer download links.

Optional: set `PUBLIC_URL` to the same URL if you use a custom domain.

### 5. Stop the local bot

Only one process may use the same `DISCORD_TOKEN`:

```powershell
Stop-Service denuvo-bot, denuvo-tunnel -ErrorAction SilentlyContinue
```

## Plans

| Plan | Bot uptime |
|------|------------|
| **Free** web service | Sleeps after ~15 min idle — **not suitable** for Discord |
| **Starter ($7/mo)** | Always on — **use this** (set in `render.yaml`) |

## Patreon / webhooks

After deploy, update:

- Patreon webhook → `https://YOUR-SERVICE.onrender.com/webhooks/patreon`
- Patreon OAuth redirect → `https://YOUR-SERVICE.onrender.com/patreon/oauth/callback`

## Magic files (Ubisoft / EA)

Large zip files are **not** in Git. Upload them via Render **Disks** (paid) or host magic zips elsewhere and set catalog URLs — same as Railway.

## Manual service (without Blueprint)

1. **New → PostgreSQL** → copy internal DB URL  
2. **New → Web Service** → Docker → repo root  
3. Dockerfile path: `./Dockerfile`  
4. Health check path: `/payload/health`  
5. Paste env from `dist/render-env.txt` + `DATABASE_URL`
