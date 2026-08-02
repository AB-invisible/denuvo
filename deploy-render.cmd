@echo off
cd /d "%~dp0"
echo === Denuvo Render deploy ===
echo.

echo [1/4] Generating env files...
call node scripts\generate-render-env.js
if errorlevel 1 exit /b 1

echo.
echo [2/4] Committing and pushing to GitHub...
git add render.yaml Dockerfile .dockerignore docs/RENDER.md scripts/generate-render-env.js scripts/setup-render.js deploy-render.cmd src/utils/cloudPublicUrl.ts src/config.ts src/lib/prisma.ts src/utils/downloadHost.ts src/payloadServer.ts scripts/prestart-db.js headless_token.py package.json .env.example
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Add Render deployment for denuvo bot"
  git push origin HEAD
) else (
  echo Nothing new to commit — continuing.
)

echo.
echo [3/4] Stopping local bot (same Discord token)...
powershell -NoProfile -Command "Stop-Service denuvo-bot,denuvo-tunnel -ErrorAction SilentlyContinue"

echo.
echo [4/4] Render API setup...
call node scripts\setup-render.js
if errorlevel 1 (
  echo.
  echo Manual step required:
  echo   1. Create API key: https://dashboard.render.com/u/settings#api-keys
  echo   2. Add RENDER_API_KEY=rnd_... to .env
  echo   3. Open https://dashboard.render.com/blueprint/new
  echo   4. Connect GitHub repo TheMich157/denuvo and apply render.yaml
  echo   5. Paste values from dist\render-env.txt when prompted
  echo   6. Run: npm run render:setup
)

pause
