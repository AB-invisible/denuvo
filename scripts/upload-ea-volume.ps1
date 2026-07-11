# Upload EA magic zip to Railway volume in base64 chunks (binary-safe over SSH).
param(
  [string]$ZipPath = (Join-Path $PSScriptRoot '..\ea-magic\EA SPORTS FC 26 magic files.zip'),
  [string]$Service = 'denuvo',
  [string]$RemoteDir = '/data/ea-magic',
  [string]$RemoteName = 'EA SPORTS FC 26 magic files.zip',
  [int]$ChunkBytes = 4194304
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ZipPath)) { throw "Missing zip: $ZipPath" }

$expected = (Get-Item -LiteralPath $ZipPath).Length
$chunkDir = Join-Path $env:TEMP "ea-magic-chunks"
if (Test-Path $chunkDir) { Remove-Item $chunkDir -Recurse -Force }
New-Item -ItemType Directory -Path $chunkDir | Out-Null

Write-Host "Splitting $ZipPath ($expected bytes) into $ChunkBytes-byte chunks..."
$fs = [System.IO.File]::OpenRead($ZipPath)
$buf = New-Object byte[] $ChunkBytes
$idx = 0
$parts = @()
try {
  while (($read = $fs.Read($buf, 0, $buf.Length)) -gt 0) {
    $part = Join-Path $chunkDir ("part_{0:D3}" -f $idx)
    $out = [System.IO.File]::Open($part, [System.IO.FileMode]::Create)
    try { $out.Write($buf, 0, $read) } finally { $out.Close() }
    $parts += $part
    $idx++
  }
} finally { $fs.Close() }

function Send-Chunk([string]$B64, [string]$RemotePath) {
  $railway = (Get-Command railway -ErrorAction Stop).Source
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $railway
  $psi.Arguments = "ssh -s $Service -- base64 -d >> '$RemotePath'"
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $p = [Diagnostics.Process]::Start($psi)
  $p.StandardInput.Write($B64)
  $p.StandardInput.Close()
  $err = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) { throw "ssh failed: $err" }
}

Push-Location (Join-Path $PSScriptRoot '..')
try {
  railway service link $Service | Out-Null
  railway ssh -s $Service -- "mkdir -p '$RemoteDir' && rm -f '$RemoteDir/$RemoteName'" | Out-Null
  $remotePath = "$RemoteDir/$RemoteName"

  $n = 0
  foreach ($part in $parts) {
    $n++
    $name = Split-Path $part -Leaf
    Write-Host "[$n/$($parts.Count)] $name ..."
    $chunk = [IO.File]::ReadAllBytes($part)
    $b64 = [Convert]::ToBase64String($chunk)
    Send-Chunk $b64 $remotePath
  }

  $remoteSize = (railway ssh -s $Service -- "wc -c < '$remotePath'").Trim()
  Write-Host "Remote size: $remoteSize (expected $expected)"
  if ([int64]$remoteSize -ne [int64]$expected) {
    throw "Size mismatch"
  }
  Write-Host "Done."
} finally {
  Pop-Location
  Remove-Item $chunkDir -Recurse -Force -ErrorAction SilentlyContinue
}
