<#
.SYNOPSIS
  Auto-sync DLLs from MKTL into the bot's templates, commit, and push.
  Designed to be run by Windows Task Scheduler unattended.

.DESCRIPTION
  Workflow:
    1. Runs tools/sync_from_mktl.py (skips steamclient64/coldloader/steam_api by default).
    2. Stages only _Template/_Core/tools changes (ignores log file, untracked junk).
    3. If anything was staged, commits and pushes to origin/main.
    4. Both Railway projects auto-deploy on push.
    5. Logs everything to tools/sync_and_push.log (gitignored).

  Returns exit 0 on success (whether or not there was anything to push).
  Returns non-zero on failure (Task Scheduler will mark the run as failed).

.PARAMETER DryRun
  Show what would happen but don't commit or push.

.EXAMPLE
  # Manual run:
  powershell -ExecutionPolicy Bypass -File C:\Users\ayoub\Downloads\denuvo-main\tools\sync_and_push.ps1

.EXAMPLE
  # Preview without changes:
  powershell -ExecutionPolicy Bypass -File C:\...\sync_and_push.ps1 -DryRun
#>

param(
    [switch]$DryRun
)

# ------------------------------------------------------------------------
# Config
# ------------------------------------------------------------------------
$ProjectRoot = "C:\Users\ayoub\Downloads\denuvo-main"
$PythonExe   = "python"
$LogFile     = Join-Path $ProjectRoot "tools\sync_and_push.log"
$Branch      = "main"
$Remote      = "origin"

# DLLs to skip beyond the default (coldloader.dll + steam_api64.dll are
# always skipped because they're custom in your setup).
$SkipDlls = @("steamclient64.dll")

# ------------------------------------------------------------------------
# Setup
# ------------------------------------------------------------------------
$ErrorActionPreference = "Stop"

function Now { return (Get-Date -Format "yyyy-MM-dd HH:mm:ss") }

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $line = "[$(Now)] [$Level] $Message"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

# Ensure log directory exists
$logDir = Split-Path $LogFile -Parent
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

Write-Log "=== sync_and_push.ps1 start (DryRun=$DryRun) ==="

# ------------------------------------------------------------------------
# Sanity checks
# ------------------------------------------------------------------------
if (-not (Test-Path $ProjectRoot)) {
    Write-Log "Project root not found: $ProjectRoot" "ERROR"
    exit 1
}
Set-Location $ProjectRoot

if (-not (Test-Path "tools\sync_from_mktl.py")) {
    Write-Log "tools\sync_from_mktl.py missing" "ERROR"
    exit 1
}
if (-not (Test-Path ".git")) {
    Write-Log ".git not found in $ProjectRoot - is this the bot repo?" "ERROR"
    exit 1
}

# ------------------------------------------------------------------------
# Step 1: Run the sync (always non-interactive, --yes)
# ------------------------------------------------------------------------
$syncArgs = @("tools\sync_from_mktl.py", "--update-manifests", "--yes")
foreach ($d in $SkipDlls) { $syncArgs += @("--skip", $d) }
if ($DryRun) { $syncArgs += "--dry-run" }

Write-Log "Running: $PythonExe $($syncArgs -join ' ')"
$syncOutput = & $PythonExe @syncArgs 2>&1 | Out-String
Add-Content -Path $LogFile -Value $syncOutput -Encoding UTF8

if ($LASTEXITCODE -ne 0) {
    $code = $LASTEXITCODE
    Write-Log "sync_from_mktl.py failed with exit code $code" "ERROR"
    exit $code
}

# ------------------------------------------------------------------------
# Step 2: Stage only the relevant directories (avoids log files / untracked junk)
# ------------------------------------------------------------------------
Write-Log "Staging _Template + _Core changes..."
git add _Template _Core 2>&1 | Out-String | ForEach-Object { if ($_) { Write-Log $_ } }
if ($LASTEXITCODE -ne 0) {
    $code = $LASTEXITCODE
    Write-Log "git add failed, exit code $code" "ERROR"
    exit $code
}

# Check if anything was actually staged
git diff --cached --quiet
$stagedChanges = ($LASTEXITCODE -ne 0)  # quiet returns 1 when there ARE changes

if (-not $stagedChanges) {
    Write-Log "Nothing staged - MKTL DLLs already in sync."
    exit 0
}

Write-Log "Changes staged. Diff stat:"
git diff --cached --stat 2>&1 | Out-String | ForEach-Object { if ($_) { Write-Log $_ } }

if ($DryRun) {
    Write-Log "DryRun mode - reverting staged changes and exiting."
    git reset HEAD _Template _Core 2>&1 | Out-Null
    exit 0
}

# ------------------------------------------------------------------------
# Step 3: Commit + push
# ------------------------------------------------------------------------
$commitMsg = "Auto-sync DLLs from MKTL ($((Get-Date -Format 'yyyy-MM-dd HH:mm')))"
Write-Log "Committing: $commitMsg"
git commit -m "$commitMsg" 2>&1 | Out-String | ForEach-Object { if ($_) { Write-Log $_ } }
if ($LASTEXITCODE -ne 0) {
    $code = $LASTEXITCODE
    Write-Log "git commit failed, exit code $code" "ERROR"
    exit $code
}

Write-Log "Pushing to $Remote/$Branch..."
git push $Remote $Branch 2>&1 | Out-String | ForEach-Object { if ($_) { Write-Log $_ } }
if ($LASTEXITCODE -ne 0) {
    $code = $LASTEXITCODE
    Write-Log "git push failed, exit code $code" "ERROR"
    exit $code
}

Write-Log "=== Done. Both Railway projects should auto-redeploy. ==="
exit 0
