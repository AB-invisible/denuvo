# Run ea-service locally on YOUR PC (same machine as browser login).
# EA remid cookies only work from the IP that created them — Railway cannot use them.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "Loading Railway ea-service credentials..."
$vars = railway variables --json | ConvertFrom-Json

$env:EA_EMAIL = $vars.EA_EMAIL
$env:EA_PASSWORD = $vars.EA_PASSWORD
$env:EA_SERVICE_KEY = $vars.EA_SERVICE_KEY
$env:EA_SESSION_PATH = Join-Path $env:LOCALAPPDATA "GameGen\ea_session.json"
$env:EA_HOST = "127.0.0.1"
$env:PORT = "8081"

New-Item -ItemType Directory -Path (Split-Path $env:EA_SESSION_PATH) -Force | Out-Null

Write-Host "Starting ea-service on http://127.0.0.1:8081"
Write-Host "Session file: $env:EA_SESSION_PATH"
python app.py
