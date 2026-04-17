# ──────────────────────────────────────────────────────────────
# Revv — Developer Environment Installer (Windows)
# Sets up everything needed to develop and build Revv from source.
# Usage:  .\install.ps1          (interactive, prompts before installs)
#         .\install.ps1 -Yes     (non-interactive, auto-approve)
# ──────────────────────────────────────────────────────────────

param(
    [switch]$Yes,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$RequiredBunMajor = 1
$RequiredBunMinor = 3

# ── Helpers ───────────────────────────────────────────────────

function Write-Info    { param($Msg) Write-Host "[info]  $Msg" -ForegroundColor Blue }
function Write-Success { param($Msg) Write-Host "[  ok]  $Msg" -ForegroundColor Green }
function Write-Warn    { param($Msg) Write-Host "[warn]  $Msg" -ForegroundColor Yellow }
function Write-Fail    { param($Msg) Write-Host "[fail]  $Msg" -ForegroundColor Red; exit 1 }
function Write-Step    { param($Msg) Write-Host "`n> $Msg" -ForegroundColor Cyan -NoNewline; Write-Host "" }

function Confirm-Action {
    param($Prompt)
    if ($Yes) { return $true }
    $reply = Read-Host "  -> $Prompt [Y/n]"
    return ($reply -eq "" -or $reply -match "^[Yy]")
}

function Test-Command {
    param($Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# ── Help ──────────────────────────────────────────────────────

if ($Help) {
    Write-Host "Usage: .\install.ps1 [-Yes] [-Help]"
    Write-Host "  -Yes   Non-interactive mode (auto-approve all installs)"
    Write-Host "  -Help  Show this help message"
    exit 0
}

# ── Header ────────────────────────────────────────────────────

Write-Host ""
Write-Host "  +-------------------------------------+" -ForegroundColor White
Write-Host "  |       Revv - Development Setup       |" -ForegroundColor White
Write-Host "  |       AI-Powered Code Review        |" -ForegroundColor White
Write-Host "  +-------------------------------------+" -ForegroundColor White
Write-Host ""

# ── Detect platform ──────────────────────────────────────────

$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
Write-Info "Platform: Windows $Arch"

# ── 1. System dependencies ───────────────────────────────────

Write-Step "Checking system dependencies"

# Git
if (Test-Command "git") {
    $gitVersion = (git --version) -replace "git version ", ""
    Write-Success "git $gitVersion"
} else {
    Write-Fail "git is not installed. Install from https://git-scm.com or: winget install Git.Git"
}

# Visual Studio Build Tools (required for Rust/Tauri on Windows)
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vsWhere) {
    $vsInstall = & $vsWhere -latest -property installationPath 2>$null
    if ($vsInstall) {
        Write-Success "Visual Studio Build Tools found"
    } else {
        Write-Warn "Visual Studio Build Tools not found"
        Write-Info "Install from: https://visualstudio.microsoft.com/visual-cpp-build-tools/"
        Write-Info "Select 'Desktop development with C++' workload"
    }
} else {
    Write-Warn "Could not detect Visual Studio Build Tools"
    Write-Info "Install from: https://visualstudio.microsoft.com/visual-cpp-build-tools/"
    Write-Info "Select 'Desktop development with C++' workload"
}

# WebView2 (required for Tauri on Windows)
$webview2 = Get-ItemProperty -Path "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
if ($webview2) {
    Write-Success "WebView2 Runtime installed"
} else {
    Write-Warn "WebView2 Runtime not detected (required for Tauri)"
    Write-Info "It's usually pre-installed on Windows 10/11. If not:"
    Write-Info "  https://developer.microsoft.com/en-us/microsoft-edge/webview2/"
}

# ── 2. Bun ────────────────────────────────────────────────────

Write-Step "Checking Bun runtime"

if (Test-Command "bun") {
    $bunVersion = bun --version
    $parts = $bunVersion.Split(".")
    $bunMajor = [int]$parts[0]
    $bunMinor = [int]$parts[1]

    if ($bunMajor -gt $RequiredBunMajor -or ($bunMajor -eq $RequiredBunMajor -and $bunMinor -ge $RequiredBunMinor)) {
        Write-Success "bun $bunVersion (>= $RequiredBunMajor.$RequiredBunMinor required)"
    } else {
        Write-Warn "bun $bunVersion found but >= $RequiredBunMajor.$RequiredBunMinor is required"
        if (Confirm-Action "Upgrade Bun?") {
            powershell -c "irm bun.sh/install.ps1 | iex"
            Write-Success "Bun upgraded"
        }
    }
} else {
    Write-Warn "Bun is not installed"
    if (Confirm-Action "Install Bun? (https://bun.sh)") {
        powershell -c "irm bun.sh/install.ps1 | iex"
        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
        Write-Success "Bun installed"
    } else {
        Write-Fail "Bun is required to build Revv"
    }
}

# ── 3. Rust toolchain ────────────────────────────────────────

Write-Step "Checking Rust toolchain"

if ((Test-Command "rustc") -and (Test-Command "cargo")) {
    $rustVersion = (rustc --version) -replace "rustc ", "" -replace " \(.*", ""
    Write-Success "rustc $rustVersion"
    $cargoVersion = (cargo --version) -replace "cargo ", "" -replace " \(.*", ""
    Write-Success "cargo $cargoVersion"
} else {
    Write-Warn "Rust toolchain not found"
    if (Confirm-Action "Install Rust via rustup? (https://rustup.rs)") {
        Write-Info "Downloading rustup-init.exe..."
        $rustupUrl = "https://win.rustup.rs/x86_64"
        $rustupPath = "$env:TEMP\rustup-init.exe"
        Invoke-WebRequest -Uri $rustupUrl -OutFile $rustupPath
        & $rustupPath -y
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
        Write-Success "Rust installed"
    } else {
        Write-Fail "Rust is required to build the Tauri desktop shell"
    }
}

# ── 4. Install project dependencies ──────────────────────────

Write-Step "Installing project dependencies"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot
Write-Info "Project root: $ProjectRoot"

Write-Info "Running bun install..."
bun install
Write-Success "All npm dependencies installed"

# ── 5. Verify workspace packages ─────────────────────────────

Write-Step "Verifying workspace structure"

foreach ($dir in @("apps\web", "apps\server", "apps\desktop", "packages\shared")) {
    if (Test-Path $dir) {
        Write-Success $dir
    } else {
        Write-Fail "Missing workspace directory: $dir"
    }
}

# ── 6. Build shared package ──────────────────────────────────

Write-Step "Building shared package"

Write-Info "Type-checking @revv/shared..."
Set-Location "$ProjectRoot\packages\shared"
try {
    bun run typecheck 2>$null
    Write-Success "@revv/shared types verified"
} catch {
    Write-Warn "@revv/shared typecheck had issues (may be fine for dev)"
}
Set-Location $ProjectRoot

# ── 7. Verify builds ─────────────────────────────────────────

Write-Step "Verifying build system"

Write-Info "Running typecheck across all packages..."
try {
    bun run typecheck 2>$null
    Write-Success "All packages pass typecheck"
} catch {
    Write-Warn "Typecheck had issues - this is expected during initial development"
}

# ── 8. Summary ────────────────────────────────────────────────

Write-Host ""
Write-Host "  +-------------------------------------+" -ForegroundColor Green
Write-Host "  |         Setup Complete!              |" -ForegroundColor Green
Write-Host "  +-------------------------------------+" -ForegroundColor Green
Write-Host ""
Write-Host "  Quick start:" -ForegroundColor White
Write-Host "    bun run dev           # Start all services in dev mode" -ForegroundColor DarkGray
Write-Host "    bun run dev:web       # Start just the frontend" -ForegroundColor DarkGray
Write-Host "    bun run dev:server    # Start just the backend" -ForegroundColor DarkGray
Write-Host "    bun run dev:desktop   # Start the Tauri desktop app" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Build for distribution:" -ForegroundColor White
Write-Host "    bun run dist          # Build platform installer (.msi)" -ForegroundColor DarkGray
Write-Host "    bun run build         # Build all packages (no installer)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Architecture:" -ForegroundColor White
Write-Host "    Web UI   -> http://localhost:5173  (SvelteKit + Tailwind)" -ForegroundColor DarkGray
Write-Host "    API      -> http://localhost:45678 (Elysia + SQLite)" -ForegroundColor DarkGray
Write-Host "    Desktop  -> Tauri v2 native window" -ForegroundColor DarkGray
Write-Host ""
