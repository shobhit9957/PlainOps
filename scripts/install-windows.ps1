# PlainOps Windows installer.
#
# Why this exists: browser downloads get Windows' mark-of-the-web, which
# triggers SmartScreen's "Windows protected your PC" for unsigned apps.
# This script fetches the same installer, strips the mark (Unblock-File),
# and installs silently — no dialogs. Per-user install, no admin prompt.
#
#   powershell -c "irm https://raw.githubusercontent.com/shobhit9957/PlainOps/main/scripts/install-windows.ps1 | iex"
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$url = 'https://github.com/shobhit9957/PlainOps/releases/latest/download/PlainOps-Setup.exe'
$setup = Join-Path $env:TEMP 'PlainOps-Setup.exe'

Write-Host 'Downloading PlainOps (latest release)...'
Invoke-WebRequest -Uri $url -OutFile $setup -UseBasicParsing
Unblock-File $setup

Write-Host 'Installing (per-user, silent)...'
Start-Process $setup -ArgumentList '/S' -Wait
Remove-Item $setup -Force -ErrorAction SilentlyContinue

$app = Join-Path $env:LOCALAPPDATA 'Programs\PlainOps\PlainOps.exe'
if (Test-Path $app) {
  Write-Host 'Done — launching PlainOps.'
  Start-Process $app
} else {
  Write-Host 'Install finished but PlainOps.exe was not found — download the installer from plainops.cloud and run it manually.'
}
