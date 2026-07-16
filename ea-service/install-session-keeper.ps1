# Auto-refresh EA remid every 2 days — set-and-forget session keeper.
# Run once as admin (or your user):  .\ea-service\install-session-keeper.ps1

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$keeperScript = Join-Path $PSScriptRoot 'run-session-keeper.ps1'
$taskName = 'GameGen-EA-Session-Keeper'

if (-not (Test-Path $keeperScript)) {
    Write-Error "Missing $keeperScript"
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$keeperScript`""

$trigger = New-ScheduledTaskTrigger -Daily -At '04:00' -DaysInterval 2

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Refreshes EA JUNO remid cookie for GameGen ea-service (every 2 days)' `
    -Force | Out-Null

Write-Host "Registered scheduled task: $taskName (every 2 days at 4:00 AM)"
Write-Host "Run now to test: powershell -File `"$keeperScript`""
