@echo off
title GameGen EA Local Service
cd /d "%~dp0"
echo Starting local EA token service on port 8081...
echo Your PC must stay on for EA tokens to work.
start "EA Service" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-local-ea.ps1"
timeout /t 5 /nobreak >nul
echo Starting tunnel (localtunnel)...
start "EA Tunnel" cmd /c "npx -y localtunnel --port 8081"
echo.
echo After tunnel shows a URL, update Railway if it changed:
echo   railway service denuvo
echo   railway variables --set EA_SERVICE_URL=https://YOUR-URL.loca.lt
echo.
echo Then run refresh-ea-session.bat once if /eahealth shows stale.
pause
