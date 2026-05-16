@echo off
REM Local build script for installer.exe. Run this once on Windows after
REM installing PyInstaller. Output goes to dist\installer.exe, which the bot
REM picks up from _Core\installer.exe.

setlocal
cd /d "%~dp0"

where pyinstaller >nul 2>&1
if errorlevel 1 (
  echo Installing PyInstaller...
  py -m pip install --upgrade pyinstaller
)

py -m PyInstaller ^
  --onefile ^
  --noconsole ^
  --name installer ^
  --distpath dist ^
  --workpath build ^
  --specpath build ^
  installer.py

if errorlevel 1 (
  echo Build failed.
  exit /b 1
)

if not exist "..\_Core" mkdir "..\_Core"
copy /Y dist\installer.exe ..\_Core\installer.exe

echo.
echo Built _Core\installer.exe — commit it so headless_token.py can bundle it.
