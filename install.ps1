# Cupertino Terminal - one-command installer for Windows.
#
#   irm https://raw.githubusercontent.com/natureco-official/cupertino-terminal/main/install.ps1 | iex
#
# Downloads the latest signed NSIS installer from GitHub Releases, installs it silently for the
# current user (no admin needed), and launches the app.
$ErrorActionPreference = 'Stop'
$repo = 'natureco-official/cupertino-terminal'

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }

Say "Locating the latest Windows build..."
$headers = @{ 'User-Agent' = 'cupertino-installer'; 'Accept' = 'application/vnd.github+json' }
$rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
$asset = $rel.assets | Where-Object { $_.name -like '*_x64-setup.exe' } | Select-Object -First 1
if (-not $asset) { throw "No x64 setup .exe found in the latest release ($($rel.tag_name))." }

$tmp = Join-Path $env:TEMP $asset.name
Say "Downloading $($asset.name)..."
Invoke-WebRequest $asset.browser_download_url -OutFile $tmp -UseBasicParsing

Say "Quitting any running instance..."
Get-Process -Name 'cupertino-terminal' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Say "Installing (silent, current user)..."
$p = Start-Process -FilePath $tmp -ArgumentList '/S' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "Installer exited with code $($p.ExitCode)." }
Remove-Item $tmp -ErrorAction SilentlyContinue

$exe = Join-Path $env:LOCALAPPDATA 'Cupertino Terminal\cupertino-terminal.exe'
if (Test-Path $exe) {
  Say "Launching..."
  Start-Process $exe
  Write-Host "==> Done - Cupertino Terminal $($rel.tag_name) is installed." -ForegroundColor Green
} else {
  Write-Host "==> Installed $($rel.tag_name) - find 'Cupertino Terminal' in the Start Menu." -ForegroundColor Green
}
