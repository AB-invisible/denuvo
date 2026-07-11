# Upload EA magic zip to Railway volume using 32MB tar streams (binary-safe).
param(
  [string]$ZipPath = (Join-Path $PSScriptRoot '..\ea-magic\EA SPORTS FC 26 magic files.zip'),
  [string]$Service = 'denuvo',
  [string]$RemoteDir = '/data/ea-magic',
  [string]$RemoteName = 'EA SPORTS FC 26 magic files.zip',
  [int]$ChunkBytes = 33554432
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ZipPath)) { throw "Missing zip: $ZipPath" }

$expected = (Get-Item -LiteralPath $ZipPath).Length
$chunkDir = Join-Path $env:TEMP "ea-magic-chunks"
if (Test-Path $chunkDir) { Remove-Item $chunkDir -Recurse -Force }
New-Item -ItemType Directory -Path $chunkDir | Out-Null

Write-Host "Splitting $ZipPath ($expected bytes)..."
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

Push-Location (Join-Path $PSScriptRoot '..')
try {
  railway service link $Service | Out-Null
  railway ssh -s $Service -- "mkdir -p '$RemoteDir' && rm -f '$RemoteDir/$RemoteName'" | Out-Null
  $remotePath = "$RemoteDir/$RemoteName"
  $staging = '/tmp/ea-chunk'

  $n = 0
  foreach ($part in $parts) {
    $n++
    $leaf = Split-Path $part -Leaf
    Write-Host "[$n/$($parts.Count)] $leaf ..."
    $cmd = "mkdir -p '$staging' && tar -xf - -C '$staging' && cat '$staging/$leaf' >> '$remotePath' && rm -rf '$staging'"
    cmd /c "tar -cf - -C `"$chunkDir`" $leaf | railway ssh -s $Service -- `"$cmd`""
    if ($LASTEXITCODE -ne 0) { throw "chunk $leaf failed" }
  }

  $remoteSize = (railway ssh -s $Service -- "wc -c < '$remotePath'").Trim()
  railway ssh -s $Service -- "chmod 644 '$remotePath'" | Out-Null
  Write-Host "Remote size: $remoteSize (expected $expected)"
  if ([int64]$remoteSize -ne [int64]$expected) { throw "Size mismatch" }
  Write-Host "Done."
} finally {
  Pop-Location
  Remove-Item $chunkDir -Recurse -Force -ErrorAction SilentlyContinue
}
