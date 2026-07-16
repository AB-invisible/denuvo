# Deploy ea-service to Railway without uploading the whole monorepo.
# Railway CLI walks up to the git root — running `railway up` from denuvo/ or
# denuvo/ea-service/ snapshots ~200MB and gets stuck at "Taking a snapshot".
#
# Usage (from repo root):
#   .\ea-service\deploy.ps1

$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot '.'
$dest = Join-Path $env:TEMP 'ea-service-railway-deploy'

if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Path $dest | Out-Null
Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force
Remove-Item -Recurse -Force (Join-Path $dest '__pycache__') -ErrorAction SilentlyContinue

Set-Location $dest
Write-Host "Deploying from $dest ($(Get-ChildItem -File | Measure-Object -Property Length -Sum | ForEach-Object { [math]::Round($_.Sum/1KB,1) }) KB)..."
railway link -p overflowing-enthusiasm -e production -s ea-service
railway up --detach
Write-Host "Done. Check /health for login_build=4 when the build finishes."
