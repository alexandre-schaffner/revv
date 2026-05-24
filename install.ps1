#Requires -Version 5.1
# ──────────────────────────────────────────────────────────────
# Revv — Unified Installer (Windows)
#
# One script, two audiences:
#
#   Curl-piped (end user) — use the signed release installer instead:
#     irm https://github.com/alexandre-schaffner/revv/releases/latest/download/install.ps1 | iex
#
#   From a checkout (developer):
#     .\install.ps1 -Dev       # toolchain + bun install, stop there
#     .\install.ps1            # full install (build .exe, scheduled task, CLI)
#
# Parameters:
#   -Dev            Install the dev toolchain and project deps, nothing more.
#                   Use this before running `make dev`.
#   -Yes, -y        Non-interactive: auto-approve every prompt.
#   -Help           This message.
#
# Environment overrides:
#   REVV_REPO_URL         Git URL (default: https://github.com/alexandre-schaffner/revv.git)
#   REVV_BRANCH           Branch to clone (default: main)
#   REVV_INSTALL_DIR      Source install dir (default: $env:APPDATA\Revv\src)
#   REVV_APP_DIR          App install dir  (default: $env:LOCALAPPDATA\Revv)
#   REVV_AUTO_YES=1       Same as -Yes
#
# Notes:
#   No .env prompts. Revv's GitHub OAuth App is bundled; secrets are
#   generated locally and never leave the machine.
# ──────────────────────────────────────────────────────────────

param(
    [switch]$Dev,
    [Alias('y')][switch]$Yes,
    [switch]$Help
)

# ── Help ──────────────────────────────────────────────────────
if ($Help) {
    @'
Revv — Unified Installer (Windows)

Usage:
  irm https://github.com/alexandre-schaffner/revv/releases/latest/download/install.ps1 | iex

  .\install.ps1 -Dev       # toolchain + deps only
  .\install.ps1            # full install

Flags:
  -Dev, -d         Install the dev toolchain and project deps, nothing more.
  -Yes, -y         Non-interactive: auto-approve every prompt.
  -Help, -h        This message.

Environment overrides:
  REVV_REPO_URL         Git URL (default: https://github.com/alexandre-schaffner/revv.git)
  REVV_BRANCH           Branch to clone (default: main)
  REVV_INSTALL_DIR      Source install dir (default: $env:APPDATA\Revv\src)
  REVV_APP_DIR          App install dir  (default: $env:LOCALAPPDATA\Revv)
  REVV_AUTO_YES=1       Same as -Yes
'@
    exit 0
}

# ── Defaults ─────────────────────────────────────────────────
$Mode = if ($Dev) { 'dev' } else { 'user' }
if ($Yes) { $env:REVV_AUTO_YES = '1' }

$REVV_REPO_URL = $env:REVV_REPO_URL ?: 'https://github.com/alexandre-schaffner/revv.git'
$REVV_BRANCH   = $env:REVV_BRANCH   ?: 'main'
$REVV_APP_DIR  = $env:REVV_APP_DIR  ?: "$env:LOCALAPPDATA\Revv"

# ── Inline bootstrap helpers ─────────────────────────────────
$ESC = [char]27
# Enable ANSI for Windows Terminal and modern consoles
try {
    Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class ConH {
    const uint ENABLE_VTP = 0x0004; const int STD_OUT = -11;
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int h);
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h, out uint m);
    [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h, uint m);
    public static void EnableAnsi() { var h=GetStdHandle(STD_OUT); uint m; GetConsoleMode(h,out m); SetConsoleMode(h,m|ENABLE_VTP); }
}
'@ -ErrorAction SilentlyContinue
    [ConH]::EnableAnsi()
    $UseColors = $true
} catch { $UseColors = $false }

if ($UseColors) {
    $_R  = "$ESC[0m";  $_B  = "$ESC[1m";  $_D  = "$ESC[2m"
    $_G  = "$ESC[32m"; $_Y  = "$ESC[33m"; $_RE = "$ESC[31m"; $_C  = "$ESC[36m"
} else {
    $_R = $_B = $_D = $_G = $_Y = $_RE = $_C = ''
}

function _info    { param($m) Write-Host "  ${_C}·${_R}  $m" }
function _success { param($m) Write-Host "  ${_G}✓${_R}  $m" }
function _warn    { param($m) Write-Host "  ${_Y}⚠${_R}  $m" }
function _fail    { param($m) Write-Host "`n  ${_RE}✗${_R}  $m`n"; exit 1 }
function _step    { param($m) Write-Host "`n  ${_B}$m${_R}" }

# ── Banner ────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ${_C}${_B}██████╗ ███████╗██╗   ██╗██╗   ██╗${_R}"
Write-Host "  ${_C}${_B}██╔══██╗██╔════╝██║   ██║██║   ██║${_R}"
Write-Host "  ${_C}${_B}██████╔╝█████╗  ██║   ██║██║   ██║${_R}"
Write-Host "  ${_C}${_B}██╔══██╗██╔══╝  ╚██╗ ██╔╝╚██╗ ██╔╝${_R}"
Write-Host "  ${_C}${_B}██║  ██║███████╗ ╚████╔╝  ╚████╔╝ ${_R}"
Write-Host "  ${_C}${_B}╚═╝  ╚═╝╚══════╝  ╚═══╝    ╚═══╝  ${_R}"
Write-Host ""
if ($Mode -eq 'dev') {
    Write-Host "  ${_D}AI-powered code review${_R}  ${_B}dev setup${_R}"
} else {
    Write-Host "  ${_D}AI-powered code review${_R}  ${_B}installer${_R}"
}
Write-Host ""
Write-Host "  ${_D}$('─' * 54)${_R}"
Write-Host ""

# ── Locate the checkout, cloning if necessary ─────────────────
$PROJECT_ROOT = ''

# Check if we're running from a local checkout
$scriptPath = $MyInvocation.MyCommand.Definition
if ($scriptPath -and (Test-Path $scriptPath)) {
    $scriptDir = Split-Path $scriptPath -Parent
    $pkgJson = Join-Path $scriptDir 'package.json'
    if (Test-Path $pkgJson) {
        $content = Get-Content $pkgJson -Raw
        if ($content -match '"name"\s*:\s*"revv"') {
            $PROJECT_ROOT = $scriptDir
        }
    }
}

if (-not $PROJECT_ROOT) {
    # Curl-pipe path: clone the repo, then re-exec
    _step 'Bootstrapping from curl'

    $dest = $env:REVV_INSTALL_DIR ?: "$env:APPDATA\Revv\src"
    $destParent = Split-Path $dest -Parent

    if (Test-Path "$dest\.git") {
        _info "Existing clone at $dest — updating"
        Push-Location $dest
        git fetch --all --prune
        git checkout $REVV_BRANCH
        git reset --hard "origin/$REVV_BRANCH"
        Pop-Location
    } elseif (Test-Path $dest) {
        _fail "$dest exists but is not a git clone. Move it aside and re-run."
    } else {
        _info "Cloning $REVV_REPO_URL ($REVV_BRANCH) -> $dest"
        New-Item -ItemType Directory -Force -Path $destParent | Out-Null
        git clone --branch $REVV_BRANCH --depth 50 $REVV_REPO_URL $dest
    }

    _info 'Re-executing installer from the cloned checkout'
    $installScript = Join-Path $dest 'install.ps1'
    $argsList = @()
    if ($Dev) { $argsList += '-Dev' }
    if ($Yes) { $argsList += '-Yes' }
    & powershell -ExecutionPolicy Bypass -File $installScript @argsList
    exit $LASTEXITCODE
}

# ── Source the shared helper library ──────────────────────────
$commonPath = Join-Path $PROJECT_ROOT 'scripts\lib\common.ps1'
if (-not (Test-Path $commonPath)) {
    _fail "$commonPath is missing. Your checkout is incomplete."
}
. $commonPath

info "Project root: $PROJECT_ROOT"

# ── 1. Platform detect ────────────────────────────────────────
step 'Detecting platform'
Detect-Platform
success "Platform: $PLATFORM ($ARCH) -> target $RUST_TARGET"

# ── 2. Toolchain ──────────────────────────────────────────────
step 'Checking build toolchain'
Ensure-VSBuildTools
Ensure-Git
Ensure-Bun
Ensure-Rust
Ensure-WebView2

# Pick up bun/cargo in this shell if they were just installed.
if (Test-Path "$env:USERPROFILE\.bun\bin") {
    $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
}
$cargoEnv = "$env:USERPROFILE\.cargo\env.ps1"
if (Test-Path $cargoEnv) { . $cargoEnv }

# ── 3. Install project deps ───────────────────────────────────
step 'Installing project dependencies'
Set-Location $PROJECT_ROOT
info 'Running bun install...'
bun install
success 'Workspace dependencies installed'

# ── 4. Dev mode exits here ────────────────────────────────────
if ($Mode -eq 'dev') {
    Write-Host "`n${_BOLD}${_GREEN}"
    Write-Host '  +-----------------------------------+'
    Write-Host '  |   ✓  Dev environment ready        |'
    Write-Host '  +-----------------------------------+'
    Write-Host "${_RESET}"
    Write-Host "  ${_BOLD}Start developing:${_RESET}"
    Write-Host "    ${_DIM}$${_RESET} make dev             ${_DIM}# all services (web, server, Tauri)${_RESET}"
    Write-Host "    ${_DIM}$${_RESET} make dev-server      ${_DIM}# API only (port 45678)${_RESET}"
    Write-Host "    ${_DIM}$${_RESET} make dev-web         ${_DIM}# frontend only (port 5173)${_RESET}"
    Write-Host ''
    Write-Host '  On first server start, Revv generates an auth key at:'
    Set-RevvPaths
    Write-Host "    $REVV_AUTH_KEY"
    Write-Host '  No .env file is required for normal use — see .env.example for'
    Write-Host '  optional overrides (custom GitHub client_id, DB path, etc.).'
    Write-Host ''
    exit 0
}

# ── 5. User install: auth key, build, ship ────────────────────

step 'Ensuring auth key'
Ensure-AuthKey

step 'Building Revv (first run can take several minutes)'
Set-Location $PROJECT_ROOT

info 'Building shared package...'
Push-Location (Join-Path $PROJECT_ROOT 'packages\shared')
bun run typecheck
Pop-Location

info 'Building web frontend + API server...'
bun run build

info 'Building Tauri desktop bundle...'
Push-Location (Join-Path $PROJECT_ROOT 'apps\desktop')
bunx tauri build --bundles app
Pop-Location

# Find the built .exe
$bundleDir = Join-Path $PROJECT_ROOT 'apps\desktop\target\release\bundle\windows'
if (-not (Test-Path $bundleDir)) {
    # Fallback search
    $bundleDir = Join-Path $PROJECT_ROOT 'apps\desktop\target\release'
}

$exeFile = Get-ChildItem -Path $bundleDir -Filter 'Revv*.exe' -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch 'msi|wix|nsis' } |
    Select-Object -First 1

if (-not $exeFile) {
    # Broader search
    $exeFile = Get-ChildItem -Path (Join-Path $PROJECT_ROOT 'apps\desktop\target') -Filter '*.exe' -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'Revv' } |
        Select-Object -First 1
}

if (-not $exeFile) {
    _fail 'Build finished but no .exe was found.'
}
success "Built $($exeFile.FullName)"

step 'Installing Revv'
$destAppDir = $REVV_APP_DIR
if (-not (Test-Path $destAppDir)) {
    New-Item -ItemType Directory -Force -Path $destAppDir | Out-Null
}

$destApp = Join-Path $destAppDir $exeFile.Name

# Stop any running instance
if (Test-ScheduledTaskExists) {
    Stop-RevvServer
}
$procs = Get-Process -Name 'Revv*' -ErrorAction SilentlyContinue
if ($procs) {
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

if (Test-Path $destApp) {
    Remove-Item $destApp -Force -ErrorAction SilentlyContinue
}
Copy-Item $exeFile.FullName $destApp
success "Installed -> $destApp"

# GitHub Enterprise config persistence
Set-RevvPaths
New-Item -ItemType Directory -Force -Path $REVV_SUPPORT_DIR | Out-Null
$confFile = Join-Path $REVV_SUPPORT_DIR 'github.conf'
if ($env:REVV_GITHUB_HOST -or $env:REVV_GITHUB_CLIENT_ID) {
    $lines = @()
    if ($env:REVV_GITHUB_HOST) { $lines += "GITHUB_HOST=$env:REVV_GITHUB_HOST" }
    if ($env:REVV_GITHUB_CLIENT_ID) { $lines += "GITHUB_CLIENT_ID=$env:REVV_GITHUB_CLIENT_ID" }
    [System.IO.File]::WriteAllLines($confFile, $lines)
    success "GitHub overrides persisted -> $confFile (host: $($env:REVV_GITHUB_HOST ?: '<bundled>'))"
} else {
    if (Test-Path $confFile) { Remove-Item $confFile -Force }
}

# ── 6. Scheduled Task (background service) ────────────────────
step 'Installing background service (Task Scheduler)'
New-Item -ItemType Directory -Force -Path $REVV_LOG_DIR | Out-Null

$bunBin = (Get-Command bun -ErrorAction SilentlyContinue)?.Source
if (-not $bunBin) {
    $bunBin = "$env:USERPROFILE\.bun\bin\bun.exe"
}
if (-not (Test-Path $bunBin)) {
    _fail 'Cannot locate bun executable for the scheduled task.'
}

$serverEntry = Join-Path $PROJECT_ROOT 'apps\server\src\index.ts'
if (-not (Test-Path $serverEntry)) {
    _fail "Server entry point missing: $serverEntry"
}

Write-ScheduledTask `
    -TaskName $REVV_TASK_NAME `
    -BunBin $bunBin `
    -ProjectRoot $PROJECT_ROOT `
    -LogDir $REVV_LOG_DIR

Start-ScheduledTask -TaskName $REVV_TASK_NAME -ErrorAction SilentlyContinue

info 'Waiting for API server on http://localhost:45678 ...'
for ($i = 1; $i -le 30; $i++) {
    try {
        $response = Invoke-WebRequest -Uri 'http://localhost:45678/' -TimeoutSec 1 -UseBasicParsing -ErrorAction SilentlyContinue
        if ($response) {
            success 'Server is listening'
            break
        }
    } catch {
        # Connection refused — keep waiting
    }
    Start-Sleep -Seconds 1
    if ($i -eq 30) {
        warn "Server didn't respond within 30s. Check logs: Get-Content '$REVV_LOG_DIR\server.err.log' -Tail 50"
    }
}

# ── 7. Install the management CLI ─────────────────────────────
step 'Installing revv CLI'
$configContent = @"
# Managed by install.ps1. The revv CLI reads these values so that subsequent
# 'revv update' / 'revv status' calls find the right paths even when the
# installer was run from a non-default location.
SOURCE_DIR=$PROJECT_ROOT
APP_PATH=$destApp
INSTALLED_AT=$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')
"@
[System.IO.File]::WriteAllText($REVV_CONFIG_FILE, $configContent)
success "Wrote $REVV_CONFIG_FILE"

New-Item -ItemType Directory -Force -Path $REVV_CLI_DIR | Out-Null
$cliDest = Join-Path $REVV_CLI_DIR 'revv.ps1'
$cliSrc = Join-Path $PROJECT_ROOT 'scripts\revv.ps1'
if (Test-Path $cliSrc) {
    Copy-Item $cliSrc $cliDest -Force
    success "Installed -> $cliDest"
}

# Ship the shared helper lib alongside the CLI
$cliLibDir = Join-Path (Split-Path $REVV_CLI_DIR -Parent) 'share\revv'
New-Item -ItemType Directory -Force -Path $cliLibDir | Out-Null
Copy-Item $commonPath (Join-Path $cliLibDir 'common.ps1') -Force

# Add CLI dir to user PATH via registry
if (Add-ToUserPath $REVV_CLI_DIR) {
    success "Added $REVV_CLI_DIR to user PATH (open a new terminal for it to take effect)"
} else {
    info "$REVV_CLI_DIR already on PATH"
}

# ── 8. Launch the app ─────────────────────────────────────────
step 'Launching Revv'
Start-Process $destApp -ErrorAction SilentlyContinue

# ── 9. Summary ────────────────────────────────────────────────
Write-Host "`n${_BOLD}${_GREEN}"
Write-Host '  +------------------------------------+'
Write-Host '  |   ✓  Revv installed successfully   |'
Write-Host '  +------------------------------------+'
Write-Host "${_RESET}"

Write-Host "  ${_BOLD}App:${_RESET}        $destApp"
Write-Host "  ${_BOLD}Source:${_RESET}     $PROJECT_ROOT"
Write-Host "  ${_BOLD}Server:${_RESET}     Revv\Server (http://localhost:45678)"
Write-Host "  ${_BOLD}Auth key:${_RESET}   $REVV_AUTH_KEY"
Write-Host "  ${_BOLD}Logs:${_RESET}       $REVV_LOG_DIR"
Write-Host "`n  ${_BOLD}Manage with the revv CLI:${_RESET}"
Write-Host "    ${_DIM}$${_RESET} revv status      show app + server status"
Write-Host "    ${_DIM}$${_RESET} revv update      pull latest, rebuild, reinstall"
Write-Host "    ${_DIM}$${_RESET} revv restart     restart the API server"
Write-Host "    ${_DIM}$${_RESET} revv logs        tail server logs"
Write-Host "    ${_DIM}$${_RESET} revv uninstall   remove everything"
Write-Host ''
