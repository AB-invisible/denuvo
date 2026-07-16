@echo off
title GameGen EA Session Refresh
cd /d "%~dp0"
echo.
echo  Opening Chrome — LOG IN to your EA account when prompted.
echo  Leave this window open until you see "imported" or an error.
echo.
set EA_IMPORT_HEADLESS=0
python import_browser_session.py
echo.
pause
