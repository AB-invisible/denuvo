# Called by Windows Task Scheduler — refreshes EA session silently.
$ErrorActionPreference = 'Stop'
$logDir = Join-Path $env:LOCALAPPDATA 'GameGen'
$logFile = Join-Path $logDir 'ea-session-keeper.log'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $logFile -Value $line
    Write-Host $line
}

try {
    Set-Location $PSScriptRoot
    Log 'starting EA session refresh'

    $varsJson = railway variables --json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "railway variables failed: $varsJson" }
    $vars = $varsJson | ConvertFrom-Json

    # Local ea-service (remid only works on the PC that logged in — not Railway)
    $env:EA_SERVICE_URL = 'http://127.0.0.1:8081'
    $env:EA_SERVICE_KEY = $vars.EA_SERVICE_KEY
    $env:EA_EMAIL = $vars.EA_EMAIL
    $env:EA_PASSWORD = $vars.EA_PASSWORD
    $env:EA_IMPORT_HEADLESS = '1'

    if (-not $env:EA_SERVICE_KEY) { throw 'EA_SERVICE_KEY missing on Railway ea-service' }

    $out = python import_browser_session.py 2>&1
    Log $out

    $health = Invoke-RestMethod -Uri "$env:EA_SERVICE_URL/health" -TimeoutSec 30
    Log "health: build=$($health.login_build) session_valid=$($health.session_valid) has_remind=$($health.has_remind)"
}
catch {
    Log "ERROR: $_"
    exit 1
}
