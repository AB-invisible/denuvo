# UbiTokenService

Linux/Railway HTTP wrapper around the Ubisoft Denuvo token minter
(`DenuvoTicket.dll`). The Discord bot calls this service to mint a Ubisoft
game token from a `token_req` ticket, the same way it calls the Steam
GameGen Auth Service.

## Why a separate service

`DenuvoTicket.exe` is a Windows-built .NET 8 **console** app that reads
`config.ini` / `LoginStore.dat` from its working directory, writes
`token/token.ini`, and exits. Its Windows-only native deps (`lzham.dll`,
`libzstd.dll` loaded via `kernel32!SetDllDirectory`) are only touched by
the manifest/download code paths — **not** by the token-mint path, which
uses protobuf over a TLS demux socket plus built-in `ZLibStream` (deflate).
Their static initializers no-op on non-Windows, so the managed assemblies
run on Linux under `dotnet DenuvoTicket.dll`.

## Endpoint

```
POST /ubisoft/token
  Header: X-Api-Key: <UBISOFT_SERVICE_KEY>
  Body:   { "ubisoftAppId": 8006, "ticket": "<token_req>",
            "email": "optional-override", "password": "optional-override" }

200 → { "token": "<gameToken>", "ownership": "<ownershipListToken>" }
4xx/5xx → { "error": "...", "code": "ExceededActivations|NotOwned|InvalidRequest|LoginFailed|Failure", "logs": "…tail…" }

GET /health → { "ok": true, "tool": true }
```

`code` maps the tool's failure phrases to stable values so the bot can
react (e.g. rotate account on `ExceededActivations`).

## Environment

| Var | Purpose |
|-----|---------|
| `UBISOFT_SERVICE_KEY` | **Required.** Shared secret; bot sends it as `X-Api-Key`. |
| `UBISOFT_EMAIL` / `UBISOFT_PASSWORD` | Default Ubisoft account (bot may override per request). |
| `LOGIN_STORE_PATH` | Path to persisted `LoginStore.dat` (device trust). Mount a Railway **volume** here so 2FA is only needed once. Default `/data/LoginStore.dat`. |
| `UBISOFT_TOOL_DIR` | Where the tool DLLs live. Default `/app/tool`. |
| `UBISOFT_TOOL_TIMEOUT_MS` | Per-request tool timeout. Default `120000`. |
| `ASPNETCORE_URLS` | Listen address. Default `http://0.0.0.0:8080`. |

## Deploy on Railway

1. New service → deploy from this repo, **root directory** `ubisoft-service`,
   builder **Dockerfile**.
2. Add a **Volume** mounted at `/data`.
3. Set `UBISOFT_SERVICE_KEY`, `UBISOFT_EMAIL`, `UBISOFT_PASSWORD`.
4. Seed `LoginStore.dat` once (interactive 2FA login on any machine), then
   upload it into the `/data` volume so automated logins skip 2FA.
5. Point the bot at the service via `UBISOFT_SERVICE_URL` + `UBISOFT_SERVICE_KEY`.

## First-login / device trust

The tool skips 2FA only when `LoginStore.dat` carries a valid trusted-device
entry. Run one interactive login to produce it, drop it in the `/data`
volume, and the service copies it in per request and writes any refreshed
copy back out.
