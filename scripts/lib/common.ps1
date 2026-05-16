# ──────────────────────────────────────────────────────────────
# Revv — Shared PowerShell helpers (sourced by install.ps1 and scripts/revv.ps1)
#
# This file is meant to be dot-sourced: . "$PSScriptRoot\common.ps1"
# It provides colors, logging helpers, prompts, platform detection,
# and toolchain-install routines that both the installer and the
# management CLI use.
# ──────────────────────────────────────────────────────────────

# ── Double-source guard ───────────────────────────────────────
if ($global:__REVV_COMMON_LOADED__) { return }
$global:__REVV_COMMON_LOADED__ = $true

# ── Colors (ANSI escape codes — Windows 10+ / Windows Terminal) ─
$script:UseColors = -not $env:NO_COLOR -and ($Host.UI.RawUI.WindowSize.Width -gt 0 -or $env:WT_SESSION)
if ($script:UseColors) {
    $script:ESC    = [char]27
    $global:REVV_RED    = "$script:ESC[0;31m"
    $global:REVV_GREEN  = "$script:ESC[0;32m"
    $global:REVV_YELLOW = "$script:ESC[1;33m"
    $global:REVV_BLUE   = "$script:ESC[0;34m"
    $global:REVV_CYAN   = "$script:ESC[0;36m"
    $global:REVV_BOLD   = "$script:ESC[1m"
    $global:REVV_DIM    = "$script:ESC[2m"
    $global:REVV_RESET  = "$script:ESC[0m"
} else {
    $global:REVV_RED    = ''
    $global:REVV_GREEN  = ''
    $global:REVV_YELLOW = ''
    $global:REVV_BLUE   = ''
    $global:REVV_CYAN   = ''
    $global:REVV_BOLD   = ''
    $global:REVV_DIM    = ''
    $global:REVV_RESET  = ''
}

# Legacy short aliases
$global:RED    = $REVV_RED
$global:GREEN  = $REVV_GREEN
$global:YELLOW = $REVV_YELLOW
$global:BLUE   = $REVV_BLUE
$global:CYAN   = $REVV_CYAN
$global:BOLD   = $REVV_BOLD
$global:DIM    = $REVV_DIM
$global:RESET  = $REVV_RESET

# ── Logging ───────────────────────────────────────────────────
function info    { param($m) Write-Host "${REVV_BLUE}[info]${REVV_RESET}  $m" }
function success { param($m) Write-Host "${REVV_GREEN}[  ok]${REVV_RESET}  $m" }
function warn    { param($m) Write-Host "${REVV_YELLOW}[warn]${REVV_RESET}  $m" }
function fail    { param($m) Write-Error "${REVV_RED}[FAIL]${REVV_RESET}  $m"; exit 1 }
function step    { param($m) Write-Host "`n${REVV_BOLD}${REVV_CYAN}> $m${REVV_RESET}" }

# ── TTY-safe prompts ─────────────────────────────────────────
function confirm {
    param([string]$Prompt)
    if ($env:REVV_AUTO_YES -eq '1') { return $true }
    $reply = Read-Host "  -> $Prompt [Y/n]"
    return [string]::IsNullOrWhiteSpace($reply) -or $reply -match '^[Yy]'
}

function check-cmd {
    param([string]$Name)
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

# ── Platform detection ────────────────────────────────────────
# Sets: $PLATFORM, $ARCH, $RUST_TARGET
function Detect-Platform {
    $arch = $env:PROCESSOR_ARCHITECTURE
    switch ($arch) {
        'AMD64' {
            $global:ARCH        = 'x86_64'
            $global:RUST_TARGET = 'x86_64-pc-windows-msvc'
        }
        'ARM64' {
            $global:ARCH        = 'aarch64'
            $global:RUST_TARGET = 'aarch64-pc-windows-msvc'
        }
        default {
            fail "Unsupported architecture: $arch"
        }
    }
    $global:PLATFORM = 'windows'
}

# ── Canonical paths ───────────────────────────────────────────
# Sets globals for all Revv directories.
function Set-RevvPaths {
    $global:REVV_SUPPORT_DIR  = $env:REVV_SUPPORT_DIR  ?: "$env:APPDATA\Revv"
    $global:REVV_LOG_DIR      = $env:REVV_LOG_DIR      ?: "$env:LOCALAPPDATA\Revv\Logs"
    $global:REVV_SRC_DIR      = $env:REVV_INSTALL_DIR  ?: "$env:APPDATA\Revv\src"
    $global:REVV_CLI_DIR      = $env:REVV_CLI_DIR      ?: "$env:USERPROFILE\.local\bin"
    $global:REVV_AUTH_KEY     = $env:REVV_AUTH_KEY     ?: "$env:APPDATA\Revv\auth.key"
    $global:REVV_TASK_NAME    = 'Revv\Server'
    $global:REVV_CONFIG_FILE  = "$env:APPDATA\Revv\config"
}

# ── Auth key management ───────────────────────────────────────
function Ensure-AuthKey {
    Set-RevvPaths
    if (Test-Path $REVV_AUTH_KEY) {
        $content = Get-Content $REVV_AUTH_KEY -Raw -ErrorAction SilentlyContinue
        if (-not [string]::IsNullOrWhiteSpace($content)) {
            success 'Auth key already present'
            return
        }
    }

    New-Item -ItemType Directory -Force -Path (Split-Path $REVV_AUTH_KEY -Parent) | Out-Null
    $bytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $hex = -join ($bytes | ForEach-Object { '{0:x2}' -f $_ })
    [System.IO.File]::WriteAllText($REVV_AUTH_KEY, $hex)
    success "Generated auth key at $REVV_AUTH_KEY"
}

# ── Toolchain checkers ────────────────────────────────────────

function Ensure-VSBuildTools {
    # Check via vswhere.exe (shipped with VS / Build Tools)
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $hasVcTools = & $vswhere -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property displayName -ErrorAction SilentlyContinue
        if ($hasVcTools) {
            success "Visual Studio Build Tools present ($hasVcTools)"
            return
        }
    }

    # Fallback: check registry for VC tools
    $vcRegPath = 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64'
    if (Test-Path $vcRegPath) {
        success 'Visual C++ Redistributable present'
        return
    }

    warn 'Visual Studio Build Tools not found'
    if (confirm 'Install Visual Studio Build Tools?') {
        info 'Opening download page — install with "Desktop development with C++" workload selected.'
        Start-Process 'https://visualstudio.microsoft.com/visual-cpp-build-tools/'
        info 'Press Enter once installation completes...'
        Read-Host
        success 'Visual Studio Build Tools check skipped (manual install)'
    } else {
        fail 'Visual Studio Build Tools are required to build the Tauri desktop shell.'
    }
}

function Ensure-Git {
    if (check-cmd git) {
        $version = (git --version).Split(' ')[2]
        success "git $version"
        return
    }
    warn 'git not found'
    if (confirm 'Install Git from https://git-scm.com?') {
        Start-Process 'https://git-scm.com/download/win'
        info 'Press Enter once installation completes...'
        Read-Host
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
        check-cmd git || fail 'git still not found after install. Add it to PATH and re-run.'
        success "git $(git --version).Split(' ')[2]"
    } else {
        fail 'git is required.'
    }
}

function Ensure-Bun {
    $requiredMajor = 1
    $requiredMinor = 3
    if (check-cmd bun) {
        $v = bun --version 2>$null
        $parts = $v -split '\.'
        $major = [int]$parts[0]
        $minor = [int]$parts[1]
        if ($major -gt $requiredMajor -or ($major -eq $requiredMajor -and $minor -ge $requiredMinor)) {
            success "bun $v"
            return
        }
        warn "bun $v is older than $requiredMajor.$requiredMinor"
        if (-not (confirm 'Upgrade Bun?')) {
            warn 'Keeping old Bun — build may fail'
            return
        }
    } else {
        warn 'Bun not found'
        if (-not (confirm 'Install Bun from https://bun.sh?')) {
            fail 'Bun is required.'
        }
    }

    info 'Installing Bun...'
    # Windows install: powershell -c "irm bun.sh/install.ps1|iex"
    $installScript = Invoke-RestMethod 'https://bun.sh/install.ps1' -ErrorAction SilentlyContinue
    if ($installScript) {
        Invoke-Expression $installScript
    } else {
        # Fallback: npm-style global install
        if (check-cmd npm) {
            npm install -g bun
        } else {
            fail 'Cannot install Bun — no installer available and npm not found.'
        }
    }

    # Refresh PATH
    $bunDir = "$env:USERPROFILE\.bun\bin"
    if (Test-Path $bunDir) {
        $env:Path = "$bunDir;$env:Path"
    }

    check-cmd bun || fail "Bun install reported success but 'bun' is not on PATH."
    success "bun $(bun --version)"
}

function Ensure-Rust {
    # Refresh cargo env if present
    $cargoEnv = "$env:USERPROFILE\.cargo\env.ps1"
    if (Test-Path $cargoEnv) {
        . $cargoEnv
    }

    if (check-cmd rustc -and check-cmd cargo) {
        $version = (rustc --version).Split(' ')[1]
        success "rustc $version"
    } else {
        warn 'Rust toolchain not found'
        if (-not (confirm 'Install Rust via rustup?')) {
            fail 'Rust is required to build the Tauri desktop shell.'
        }
        info 'Installing Rust via rustup...'
        $rustupInit = Invoke-RestMethod 'https://win.rustup.rs/x86_64' -ErrorAction SilentlyContinue
        $tempFile = Join-Path $env:TEMP 'rustup-init.exe'
        [System.IO.File]::WriteAllBytes($tempFile, [System.Text.Encoding]::UTF8.GetBytes('')) # placeholder
        # Use Invoke-WebRequest for binary download
        Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile $tempFile -UseBasicParsing
        & $tempFile -y --no-modify-path
        Remove-Item $tempFile -Force

        # Source cargo env
        if (Test-Path $cargoEnv) {
            . $cargoEnv
        } else {
            $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
        }

        check-cmd cargo || fail 'Rust installation failed — cargo not in PATH.'
        success "rustc $(rustc --version).Split(' ')[1]"
    }

    # Rust target
    if (check-cmd rustup) {
        $installed = rustup target list --installed 2>$null
        if ($installed -contains $RUST_TARGET) {
            success "Rust target $RUST_TARGET"
        } else {
            warn "Rust target $RUST_TARGET is not installed"
            if (confirm "Add Rust target $RUST_TARGET?") {
                rustup target add $RUST_TARGET
                success "Rust target $RUST_TARGET"
            } else {
                warn "Missing Rust target — Tauri build may fail"
            }
        }
    } else {
        $hostTriple = rustc -vV 2>$null | Where-Object { $_ -match '^host:' } | ForEach-Object { $_.Split(':')[1].Trim() }
        if ($hostTriple -and $hostTriple -eq $RUST_TARGET) {
            success "Rust target $RUST_TARGET (native host, rustup not required)"
        } else {
            warn "rustup not found; can't add target '$RUST_TARGET' (host is '${hostTriple}')"
        }
    }
}

function Ensure-WebView2 {
    # WebView2 is built into Windows 11. Check runtime for Win10.
    $regPaths = @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    )
    foreach ($path in $regPaths) {
        if (Test-Path $path) {
            $version = (Get-ItemProperty $path -ErrorAction SilentlyContinue).pv
            if ($version) {
                success "WebView2 Runtime $version"
                return
            }
        }
    }

    # Check if on Windows 11 (build >= 22000)
    $winBuild = [System.Environment]::OSVersion.Version.Build
    if ($winBuild -ge 22000) {
        success 'WebView2 (built into Windows 11)'
        return
    }

    warn 'WebView2 Runtime not found'
    if (confirm 'Install WebView2 Runtime?') {
        Start-Process 'https://developer.microsoft.com/en-us/microsoft-edge/webview2/#download-section'
        info 'Press Enter once installation completes...'
        Read-Host
        success 'WebView2 Runtime check skipped (manual install)'
    } else {
        fail 'WebView2 Runtime is required for Tauri apps.'
    }
}

# ── Task Scheduler service management ─────────────────────────
# Creates a user-level scheduled task that runs the Revv server at logon.

function Write-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$BunBin,
        [string]$ProjectRoot,
        [string]$LogDir
    )

    if (-not $BunBin) { fail 'Write-ScheduledTask: BunBin required' }
    if (-not (Test-Path $ProjectRoot)) { fail "Write-ScheduledTask: ProjectRoot missing: $ProjectRoot" }
    if (-not $LogDir) { fail 'Write-ScheduledTask: LogDir required' }

    # Detect claude / opencode binaries for MCP
    $claudeBin = (Get-Command claude -ErrorAction SilentlyContinue)?.Source
    $opencodeBin = (Get-Command opencode -ErrorAction SilentlyContinue)?.Source
    if ($claudeBin) { info "Detected claude at $claudeBin" }
    if ($opencodeBin) { info "Detected opencode at $opencodeBin" }

    # GitHub Enterprise config resolution
    Set-RevvPaths
    $confFile = "$REVV_SUPPORT_DIR\github.conf"
    $dotenvFile = "$ProjectRoot\apps\server\.env"

    $githubHost = $env:REVV_GITHUB_HOST
    $githubClientId = $env:REVV_GITHUB_CLIENT_ID

    if (-not $githubHost -and (Test-Path $confFile)) {
        $githubHost = Get-DotEnvValue 'GITHUB_HOST' $confFile
    }
    if (-not $githubClientId -and (Test-Path $confFile)) {
        $githubClientId = Get-DotEnvValue 'GITHUB_CLIENT_ID' $confFile
    }
    if (-not $githubHost -and (Test-Path $dotenvFile)) {
        $githubHost = Get-DotEnvValue 'GITHUB_HOST' $dotenvFile
    }
    if (-not $githubClientId -and (Test-Path $dotenvFile)) {
        $githubClientId = Get-DotEnvValue 'GITHUB_CLIENT_ID' $dotenvFile
    }

    if ($githubHost) { info "Injecting GITHUB_HOST=$githubHost into scheduled task" }
    if ($githubClientId) { info 'Injecting GITHUB_CLIENT_ID into scheduled task' }

    # Build environment variables for the task
    $envVars = @{
        'HOME'                = $env:USERPROFILE
        'PATH'                = "$env:USERPROFILE\.bun\bin;$env:USERPROFILE\.cargo\bin;$env:PATH"
        'REVV_CLAUDE_BIN'     = $claudeBin ?: ''
        'REVV_OPENCODE_BIN'   = $opencodeBin ?: ''
    }
    if ($githubHost) { $envVars['GITHUB_HOST'] = $githubHost }
    if ($githubClientId) { $envVars['GITHUB_CLIENT_ID'] = $githubClientId }

    # Build the action: run bun via cmd.exe to handle .ts execution
    $action = New-ScheduledTaskAction `
        -Execute 'cmd.exe' `
        -Argument "/c `"$BunBin`" run `"$ProjectRoot\apps\server\src\index.ts`"" `
        -WorkingDirectory $ProjectRoot

    # Trigger: at logon
    $trigger = New-ScheduledTaskTrigger -AtLogOn

    # Settings: restart on failure, don't stop on idle
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)

    # Register the task
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

    $taskDefinition = New-ScheduledTask `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description 'Revv API Server — background service'

    # Set environment variables via the task definition's EnvironmentVariables (not directly supported)
    # Instead, we wrap in a .cmd batch that sets env vars then runs bun
    $batchDir = "$REVV_SUPPORT_DIR"
    New-Item -ItemType Directory -Force -Path $batchDir | Out-Null
    $batchFile = "$batchDir\start-server.cmd"

    $batchContent = @"
@echo off
set HOME=$env:USERPROFILE
set PATH=$env:USERPROFILE\.bun\bin;$env:USERPROFILE\.cargo\bin;$env:PATH
"@
    if ($claudeBin) { $batchContent += "`nset REVV_CLAUDE_BIN=$claudeBin" }
    if ($opencodeBin) { $batchContent += "`nset REVV_OPENCODE_BIN=$opencodeBin" }
    if ($githubHost) { $batchContent += "`nset GITHUB_HOST=$githubHost" }
    if ($githubClientId) { $batchContent += "`nset GITHUB_CLIENT_ID=$githubClientId" }

    $batchContent += @"

`"$BunBin`" run `"$ProjectRoot\apps\server\src\index.ts`" >> `"$LogDir\server.out.log`" 2>> `"$LogDir\server.err.log`"
"@

    [System.IO.File]::WriteAllText($batchFile, $batchContent)

    # Update action to use batch file
    $action = New-ScheduledTaskAction `
        -Execute 'cmd.exe' `
        -Argument "/c `"$batchFile`"" `
        -WorkingDirectory $ProjectRoot

    $taskDefinition = New-ScheduledTask `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description 'Revv API Server — background service'

    Register-ScheduledTask `
        -TaskName $TaskName `
        -InputObject $taskDefinition `
        -Force | Out-Null

    success "Scheduled task registered: $TaskName"
}

function Start-RevvServer {
    Start-ScheduledTask -TaskName $REVV_TASK_NAME -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    if (Test-ServerRunning) {
        success 'Server is running on http://localhost:45678'
    } else {
        warn 'Server did not come up — check revv logs'
    }
}

function Stop-RevvServer {
    Stop-ScheduledTask -TaskName $REVV_TASK_NAME -ErrorAction SilentlyContinue
    # Also kill any running bun/node processes on port 45678
    $proc = Get-NetTCPConnection -LocalPort 45678 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
    if ($proc) {
        Stop-Process -Id $proc -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
    if (-not (Test-ServerRunning)) {
        success 'Server stopped'
    } else {
        warn 'Server still responds — another process may be on port 45678'
    }
}

function Restart-RevvServer {
    Stop-RevvServer
    Start-RevvServer
}

function Test-ServerRunning {
    try {
        $response = Invoke-WebRequest -Uri 'http://localhost:45678/' -TimeoutSec 2 -UseBasicParsing -ErrorAction SilentlyContinue
        return $null -ne $response
    } catch {
        # Connection refused = not running, but other errors might mean it's up
        return $false
    }
}

function Test-ScheduledTaskExists {
    $null -ne (Get-ScheduledTask -TaskName 'Server' -TaskPath 'Revv\' -ErrorAction SilentlyContinue)
}

# ── .env parser ───────────────────────────────────────────────
function Get-DotEnvValue {
    param([string]$Key, [string]$EnvFile)
    if (-not (Test-Path $EnvFile)) { return '' }
    $lines = Get-Content $EnvFile
    foreach ($line in $lines) {
        $line = $line.Trim()
        if ($line.StartsWith('#') -or -not $line.Contains('=')) { continue }
        $parts = $line -split '=', 2
        if ($parts[0].Trim() -eq $Key) {
            $value = $parts[1].Trim()
            # Strip quotes
            if ($value.StartsWith('"') -and $value.EndsWith('"')) { $value = $value.Substring(1, $value.Length - 2) }
            elseif ($value.StartsWith("'") -and $value.EndsWith("'")) { $value = $value.Substring(1, $value.Length - 2) }
            return $value
        }
    }
    return ''
}

# ── PATH management ───────────────────────────────────────────
function Add-ToUserPath {
    param([string]$Dir)
    $currentPath = [System.Environment]::GetEnvironmentVariable('Path', 'User') ?: ''
    if ($currentPath -split ';' | Where-Object { $_ -eq $Dir }) {
        return $false # Already present
    }
    $newPath = "$currentPath;$Dir"
    [System.Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    $env:Path = "$Dir;$env:Path" # Also update current session
    return $true
}

function Remove-FromUserPath {
    param([string]$Dir)
    $currentPath = [System.Environment]::GetEnvironmentVariable('Path', 'User') ?: ''
    $entries = $currentPath -split ';' | Where-Object { $_ -ne $Dir -and $_ }
    $newPath = $entries -join ';'
    [System.Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    $env:Path = ($env:Path -split ';' | Where-Object { $_ -ne $Dir -and $_ }) -join ';'
}
