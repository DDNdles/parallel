# ============================================================
#  parallel one-click installer (Windows).
#  Downloads the latest release zip -- it ships its own Node
#  runtime, so there are NO prerequisites -- extracts it to a
#  per-user folder, adds it to the user PATH and creates a
#  Start Menu shortcut.
#
#  One-liner:
#    irm https://raw.githubusercontent.com/DDNdles/parallel/main/scripts/install.ps1 | iex
#  With options (irm|iex cannot take arguments, so wrap it):
#    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/DDNdles/parallel/main/scripts/install.ps1))) -InstallDir "D:\parallel" -NoShortcut
#
#  NOTE: keep this file ASCII-only (same reason as parallel.cmd).
# ============================================================
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\parallel",
  [string]$ZipUrl = "",   # override the zip download URL (testing / mirror)
  [switch]$NoPath,        # do not add the install dir to the user PATH
  [switch]$NoShortcut     # do not create the Start Menu shortcut
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

if (-not $ZipUrl) {
  Write-Host '[parallel] resolving latest release...'
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/DDNdles/parallel/releases/latest'
  $asset = $rel.assets | Where-Object { $_.name -match '^parallel-v[\d.]+\.zip$' } | Select-Object -First 1
  if (-not $asset) { throw "[parallel] no zip asset found in release $($rel.tag_name)" }
  $ZipUrl = $asset.browser_download_url
  Write-Host "[parallel] latest: $($rel.tag_name)"
}

$tmpZip = Join-Path $env:TEMP "parallel-install-$([guid]::NewGuid().ToString('N')).zip"
Write-Host "[parallel] downloading $ZipUrl ..."
Invoke-WebRequest -Uri $ZipUrl -OutFile $tmpZip

$tmpDir = Join-Path $env:TEMP "parallel-unzip-$([guid]::NewGuid().ToString('N'))"
Write-Host "[parallel] extracting ..."
Expand-Archive -Path $tmpZip -DestinationPath $tmpDir
$inner = Get-ChildItem $tmpDir | Where-Object { $_.PSIsContainer -and $_.Name -like 'parallel-v*' } | Select-Object -First 1
if (-not $inner) {
  Remove-Item $tmpDir -Recurse -Force; Remove-Item $tmpZip -Force
  throw '[parallel] unexpected zip layout (no parallel-vX.Y.Z folder)'
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
# Only add/overwrite program files: an existing data/ beside them (in-place upgrade) survives.
Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $InstallDir -Recurse -Force
Remove-Item $tmpDir -Recurse -Force
Remove-Item $tmpZip -Force

if (-not (Test-Path (Join-Path $InstallDir 'runtime\node.exe'))) {
  Write-Warning "[parallel] runtime\node.exe missing - install Node.js 24+ from https://nodejs.org or the bot will not start"
}

if (-not $NoPath) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $InstallDir), 'User')
    Write-Host "[parallel] added to user PATH: $InstallDir (reopen your terminal to pick it up)"
  }
}

if (-not $NoShortcut) {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'parallel.lnk'))
  $lnk.TargetPath = Join-Path $InstallDir 'parallel.cmd'
  $lnk.WorkingDirectory = $InstallDir
  $lnk.Description = 'parallel QQ bot'
  $lnk.Save()
}

Write-Host ''
Write-Host '[parallel] installed.'
Write-Host "  location : $InstallDir"
Write-Host '  run      : double-click parallel.cmd there, or open a NEW terminal and run: parallel.cmd'
Write-Host '  data     : lands in .\data under the directory you launch it from'
Write-Host '  first run: the console prints the UI address with its access token and opens your browser'
