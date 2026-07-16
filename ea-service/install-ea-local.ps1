# Install ea-service to run at Windows login + expose via Cloudflare quick tunnel.
# Run once. Requires: cloudflared (winget install Cloudflare.cloudflared)

$ErrorActionPreference = 'Stop'
$repoEa = $PSScriptRoot
$localDir = Join-Path $env:LOCALAPPDATA "GameGen\ea-local"
New-Item -ItemType Directory -Path $localDir -Force | Out-Null

# Copy service files
Copy-Item -Path (Join-Path $repoEa "*.py") -Destination $localDir -Force
Copy-Item -Path (Join-Path $repoEa "requirements.txt") -Destination $localDir -Force

$startScript = Join-Path $localDir "start.ps1"
@'
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$vars = railway variables --json 2>&1 | ConvertFrom-Json
$env:EA_EMAIL = $vars.EA_EMAIL
$env:EA_PASSWORD = $vars.EA_PASSWORD
$env:EA_SERVICE_KEY = $vars.EA_SERVICE_KEY
$env:EA_SESSION_PATH = Join-Path $env:LOCALAPPDATA "GameGen\ea_session.json"
$env:EA_HOST = "127.0.0.1"
$env:PORT = "8081"
Start-Process -WindowStyle Hidden python -ArgumentList "app.py" -WorkingDirectory $PSScriptRoot
Start-Sleep -Seconds 3
$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cf) {
  Start-Process -WindowStyle Hidden cloudflared -ArgumentList "tunnel --url http://127.0.0.1:8081"
}
'@ | Set-Content -Path $startScript -Encoding UTF8

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName 'GameGen-EA-Local-Service' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Local EA token service (remid must run on same PC as browser login)' -Force | Out-Null

Write-Host "Installed GameGen-EA-Local-Service (runs at login)"
Write-Host ""
Write-Host "NEXT: Run refresh-ea-session.bat once to log in, then update Railway bot:"
Write-Host "  railway service denuvo"
Write-Host "  railway variables --set EA_SERVICE_URL=https://YOUR-CLOUDFLARE-TUNNEL-URL"
