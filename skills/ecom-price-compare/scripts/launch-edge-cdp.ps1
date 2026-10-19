# launch-edge-cdp.ps1 — start Edge with a debugging port on a DEDICATED profile dir.
#
# Chromium 136+ refuses --remote-debugging-port together with the DEFAULT user
# data dir (that is why the Edge you already have open cannot be attached to).
# So this uses its own dir next to this script. Log in to Taobao once in that
# window and the cookies live there from then on.
#
#   powershell -ExecutionPolicy Bypass -File launch-edge-cdp.ps1
#   ... -Headless          no visible window (plumbing tests)
#   ... -Fresh             wipe the dedicated profile first
#   ... -Port 9223
#   ... -Url https://s.taobao.com/search?q=%E5%8F%A3%E7%BD%A9

[CmdletBinding()]
param(
  [int]$Port = 9222,
  [switch]$Headless,
  [switch]$Fresh,
  [string]$Url = 'https://www.taobao.com'
)

$ErrorActionPreference = 'Stop'

$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) {
  $edge = (Get-Command msedge.exe -ErrorAction SilentlyContinue).Source
  if (-not $edge) { throw "msedge.exe not found" }
}

$profileDir = Join-Path $PSScriptRoot 'edge-profile'

if ($Fresh -and (Test-Path $profileDir)) {
  $resolved = (Resolve-Path $profileDir).Path
  if ($resolved -ne (Join-Path (Resolve-Path $PSScriptRoot).Path 'edge-profile')) {
    throw "refusing to delete unexpected path: $resolved"
  }
  Write-Host "wiping $resolved"
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
New-Item -ItemType Directory -Path $profileDir -Force | Out-Null

$argList = @(
  "--remote-debugging-port=$Port"
  '--remote-debugging-address=127.0.0.1'
  "--user-data-dir=`"$profileDir`""
  '--no-first-run'
  '--no-default-browser-check'
  '--disable-sync'
  '--disable-features=Translate,msEdgeSplitScreen,msEdgeFirstRunExperience,msEdgeIdentityFRE,msSyncFRE'
)
if ($Headless) { $argList += '--headless=new' }
$argList += $Url

Write-Host "launching: $edge"
$proc = Start-Process -FilePath $edge -ArgumentList $argList -PassThru
Write-Host "pid $($proc.Id), profile $profileDir"

$deadline = (Get-Date).AddSeconds(25)
$version = $null
while ((Get-Date) -lt $deadline) {
  try {
    $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
    break
  } catch { Start-Sleep -Milliseconds 400 }
}

if (-not $version) { throw "CDP did not come up on port $Port within 25s" }

Write-Host ""
Write-Host "CDP ready on http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host "  browser : $($version.Browser)"
Write-Host "  profile : $profileDir"
Write-Host ""
Write-Host "drive it with:  node cdp.mjs list" -ForegroundColor Cyan
Write-Host "the debugging port is a local trust boundary - close this window when done." -ForegroundColor Yellow
