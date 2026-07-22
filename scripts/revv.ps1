#Requires -Version 5.1
# ──────────────────────────────────────────────────────────────
# revv — Management CLI for a Revv source install (Windows)
#
# Installed by install.ps1 to $env:USERPROFILE\.local\bin\revv.ps1.
# Drives the source tree at $env:APPDATA\Revv\src
# and the Scheduled Task at Revv\Server.
#
# Commands:
#   revv update      Pull latest, rebuild, reinstall, reinstall service
#   revv uninstall   Remove ALL Revv artifacts (app, data, config, services, CLI)
#   revv start       Start the server scheduled task
#   revv stop        Stop the server scheduled task
#   revv restart     Stop + start
#   revv status      Show versions, install paths, server state
#   revv logs        Tail the server logs
#   revv open        Open Revv.exe
#   revv doctor      Run a set of health checks
#   revv path        Print paths used by this install
#   revv help        Show this message
# ──────────────────────────────────────────────────────────────

param(
    [Parameter(Position = 0)][string]$Command = 'help'
)

# ── Default paths ─────────────────────────────────────────────
$CONFIG_FILE    = "$env:APPDATA\Revv\config"
$INSTALL_DIR    = $env:REVV_INSTALL_DIR ?: "$env:APPDATA\Revv\src"
$APP_CANDIDATES = @()
foreach ($dir in @("$env:LOCALAPPDATA\Revv", "$env:ProgramFiles\Revv")) {
    if (Test-Path $dir) {
        Get-ChildItem -Path $dir -Filter 'Revv*.exe' -ErrorAction SilentlyContinue | ForEach-Object {
            $script:APP_CANDIDATES += $_.FullName
        }
    }
}
$TASK_NAME      = 'Revv\Server'
$LOG_DIR        = $env:REVV_LOG_DIR ?: "$env:LOCALAPPDATA\Revv\Logs"
$CLI_PATH       = "$env:USERPROFILE\.local\bin\revv.ps1"
$API_URL        = 'http://localhost:45678'

# Override defaults with values persisted by the installer.
if (Test-Path $CONFIG_FILE) {
    $configContent = Get-Content $CONFIG_FILE -Raw
    foreach ($line in ($configContent -split "`n")) {
        $line = $line.Trim()
        if ($line.StartsWith('#') -or -not $line.Contains('=')) { continue }
        $parts = $line -split '=', 2
        $key = $parts[0].Trim()
        $value = $parts[1].Trim()
        switch ($key) {
            'SOURCE_DIR' { if ($value) { $INSTALL_DIR = $value } }
            'APP_PATH'   { if ($value -and (Test-Path $value)) { $script:APP_CANDIDATES = @($value) + $script:APP_CANDIDATES } }
        }
    }
}

# ── Load shared helpers ───────────────────────────────────────
$libPaths = @(
    "$env:USERPROFILE\.local\share\revv\common.ps1",
    "$INSTALL_DIR\scripts\lib\common.ps1",
    (Join-Path (Split-Path $MyInvocation.MyCommand.Definition -Parent) 'lib\common.ps1')
)
$libLoaded = $false
foreach ($lib in $libPaths) {
    if (Test-Path $lib) {
        . $lib
        $libLoaded = $true
        break
    }
}

if (-not $libLoaded) {
    # Inline fallbacks
    $ESC = [char]27
    $UseColors = -not $env:NO_COLOR -and ($Host.UI.RawUI.WindowSize.Width -gt 0 -or $env:WT_SESSION)
    if ($UseColors) {
        $RED = "$ESC[0;31m"; $GREEN = "$ESC[0;32m"; $YELLOW = "$ESC[1;33m"
        $BLUE = "$ESC[0;34m"; $CYAN = "$ESC[0;36m"; $BOLD = "$ESC[1m"
        $DIM = "$ESC[2m"; $RESET = "$ESC[0m"
    } else {
        $RED = $GREEN = $YELLOW = $BLUE = $CYAN = $BOLD = $DIM = $RESET = ''
    }
    function info    { param($m) Write-Host "${BLUE}[info]${RESET}  $m" }
    function success { param($m) Write-Host "${GREEN}[  ok]${RESET}  $m" }
    function warn    { param($m) Write-Host "${YELLOW}[warn]${RESET}  $m" }
    function fail    { param($m) Write-Host "${RED}[FAIL]${RESET}  $m" -ForegroundColor Red; exit 1 }
    function step    { param($m) Write-Host "`n${BOLD}${CYAN}> $m${RESET}" }
    function confirm {
        param([string]$Prompt)
        if ($env:REVV_AUTO_YES -eq '1') { return $true }
        $reply = Read-Host "  -> $Prompt [y/N]"
        return $reply -match '^[Yy]'
    }
    function Test-ServerRunning {
        try {
            $r = Invoke-WebRequest -Uri $API_URL -TimeoutSec 2 -UseBasicParsing -ErrorAction SilentlyContinue
            return $null -ne $r
        } catch { return $false }
    }
    function Start-RevvServer {
        Start-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        if (Test-ServerRunning) { success 'Server is running' } else { warn 'Server did not come up' }
    }
    function Stop-RevvServer {
        Stop-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
        $proc = Get-NetTCPConnection -LocalPort 45678 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
        if ($proc) { Stop-Process -Id $proc -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 1
        if (-not (Test-ServerRunning)) { success 'Server stopped' } else { warn 'Server still responds' }
    }
    function Test-ScheduledTaskExists {
        $null -ne (Get-ScheduledTask -TaskName 'Server' -TaskPath 'Revv\' -ErrorAction SilentlyContinue)
    }
    function Add-ToUserPath { param($Dir) $false }
    function Remove-FromUserPath { param($Dir) }
}

# Canonical paths
$REVV_SUPPORT_DIR = $env:REVV_SUPPORT_DIR ?: "$env:APPDATA\Revv"
$REVV_AUTH_KEY    = $env:REVV_AUTH_KEY    ?: "$env:APPDATA\Revv\auth.key"
# Canonical DB path — mirrors the server's resolveDbPath (<appDataDir>\revv.db),
# NOT the cwd/INSTALL_DIR. See apps/server/src/db/index.ts.
$REVV_DB_PATH     = $env:REVV_DB_PATH     ?: "$REVV_SUPPORT_DIR\revv.db"

function Find-App {
    foreach ($p in $script:APP_CANDIDATES) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Ensure-InstallDir {
    if (-not (Test-Path "$INSTALL_DIR\.git")) {
        fail "No Revv source install found at $INSTALL_DIR.
Run the installer first:
  irm https://raw.githubusercontent.com/alexandre-schaffner/revv/main/install.ps1 | iex"
    }
}

function Load-BunPath {
    if (Test-Path "$env:USERPROFILE\.bun\bin") {
        $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
    }
    $cargoEnv = "$env:USERPROFILE\.cargo\env.ps1"
    if (Test-Path $cargoEnv) { . $cargoEnv }
}

# ── Commands ─────────────────────────────────────────────────

function Cmd-Help {
    @'
revv — manage your Revv source install.

Usage:
  revv <command>

Commands:
  update      Pull latest code, rebuild, reinstall, reload server
  uninstall   Remove ALL Revv artifacts (app, data, config, services, CLI)
  start       Start the background API server
  stop        Stop the background API server
  restart     Restart the background API server
  status      Show install paths, versions, and server state
  logs        Tail the server log files
  open        Launch Revv.exe
  doctor      Run health checks
  path        Print the paths this install uses
  help        Show this message
'@
}

function Cmd-Path {
    Write-Host "${BOLD}Install${RESET}"
    Write-Host "  Source:          $INSTALL_DIR"
    Write-Host "  App:             $(Find-App ?: '(not installed)')"
    Write-Host "  CLI:             $CLI_PATH"
    Write-Host "  Helper lib:      $env:USERPROFILE\.local\share\revv\common.ps1"
    Write-Host ''
    Write-Host "${BOLD}Data${RESET}"
    Write-Host "  Database:        $REVV_DB_PATH"
    Write-Host "  Git clones:      $env:USERPROFILE\.revv\repos\"
    Write-Host "  Settings:        $env:USERPROFILE\.revv\settings.json"
    Write-Host "  Auth key:        $REVV_AUTH_KEY"
    Write-Host "  GitHub config:   $REVV_SUPPORT_DIR\github.conf"
    Write-Host ''
    Write-Host "${BOLD}Services${RESET}"
    Write-Host "  Server task:     Scheduled Task: $TASK_NAME"
    Write-Host "  Logs:            $LOG_DIR"
    Write-Host ''
    Write-Host "${BOLD}Tauri / WebView${RESET}"
    Write-Host "  WebView data:    $env:LOCALAPPDATA\Revv\WebView\"
    Write-Host "  App support:     $env:LOCALAPPDATA\Revv\"
    Write-Host "  Caches:          $env:LOCALAPPDATA\Revv\Cache\"
}

function Cmd-Start {
    if (-not (Test-ScheduledTaskExists)) {
        fail "Scheduled task missing. Re-run the installer."
    }
    Start-RevvServer
}

function Cmd-Stop {
    if (-not (Test-ScheduledTaskExists)) {
        warn 'Scheduled task not found'
        return
    }
    Stop-RevvServer
}

function Cmd-Restart {
    Cmd-Stop
    Cmd-Start
}

function Cmd-Status {
    step 'Revv install status'
    Ensure-InstallDir 2>$null || { warn "Source not found at $INSTALL_DIR"; return }

    Push-Location $INSTALL_DIR
    $commit = (git rev-parse --short HEAD 2>$null) ?: 'unknown'
    $branch = (git rev-parse --abbrev-ref HEAD 2>$null) ?: 'unknown'
    Pop-Location

    Write-Host "  ${BOLD}Source:${_RESET}      $INSTALL_DIR"
    Write-Host "  ${BOLD}Branch:${_RESET}      $branch @ $commit"

    $app = Find-App
    if ($app) {
        Write-Host "  ${BOLD}App:${_RESET}         $app"
    } else {
        Write-Host "  ${BOLD}App:${_RESET}         ${RED}(not installed)${RESET}"
    }

    if (Test-ScheduledTaskExists) {
        $task = Get-ScheduledTask -TaskName 'Server' -TaskPath 'Revv\' -ErrorAction SilentlyContinue
        $state = $task?.State
        if ($state -eq 'Running') {
            Write-Host "  ${BOLD}Service:${_RESET}     running"
        } else {
            Write-Host "  ${BOLD}Service:${_RESET}     $state"
        }
    } else {
        Write-Host "  ${BOLD}Service:${_RESET}     ${RED}not installed${RESET}"
    }

    if (Test-ServerRunning) {
        Write-Host "  ${BOLD}API:${_RESET}         ${GREEN}responding on $API_URL${RESET}"
    } else {
        Write-Host "  ${BOLD}API:${_RESET}         ${RED}not responding on $API_URL${RESET}"
    }

    # Upstream check
    Push-Location $INSTALL_DIR
    if (git fetch --quiet 2>$null) {
        $behind = (git rev-list --count "HEAD..@{upstream}" 2>$null) ?: 0
        if ([int]$behind -gt 0) {
            Write-Host "  ${BOLD}Update:${_RESET}      ${YELLOW}$behind commit(s) behind — run 'revv update'${RESET}"
        } else {
            Write-Host "  ${BOLD}Update:${_RESET}      up to date"
        }
    }
    Pop-Location
}

function Cmd-Logs {
    if (-not (Test-Path $LOG_DIR)) {
        fail "No log directory at $LOG_DIR"
    }
    $errLog = Join-Path $LOG_DIR 'server.err.log'
    $outLog = Join-Path $LOG_DIR 'server.out.log'
    $files = @()
    if (Test-Path $errLog) { $files += $errLog }
    if (Test-Path $outLog) { $files += $outLog }
    if ($files.Count -eq 0) {
        fail "No log files yet. Start the server with 'revv start'."
    }
    Write-Host "${DIM}Tailing $($files -join ', ') — Ctrl-C to exit${RESET}"
    Get-Content -Path $files -Wait -Tail 50
}

function Cmd-Open {
    $app = Find-App
    if (-not $app) {
        fail "Revv.exe not found. Run 'revv update' or reinstall."
    }
    Start-Process $app
}

function Cmd-Update {
    Ensure-InstallDir
    Load-BunPath
    step 'Updating Revv'

    info 'Fetching from origin'
    Push-Location $INSTALL_DIR
    git fetch --all --prune

    $branch = git rev-parse --abbrev-ref HEAD
    $before = git rev-parse HEAD
    git reset --hard "origin/$branch"
    $after = git rev-parse HEAD
    Pop-Location

    if ($before -eq $after) {
        $short = (Push-Location $INSTALL_DIR; git rev-parse --short HEAD; Pop-Location)
        info "Already up to date ($short)"
        if (-not (confirm 'Force a rebuild anyway?')) {
            success 'Nothing to do.'
            return
        }
    } else {
        info "Updated $before -> $after"
        info 'Changes:'
        Push-Location $INSTALL_DIR
        git --no-pager log --oneline "$before..$after" | ForEach-Object { Write-Host "    $_" }
        Pop-Location
    }

    info 'Installing dependencies'
    Push-Location $INSTALL_DIR
    bun install
    Pop-Location

    info 'Building (bun run build + tauri build)'
    Push-Location $INSTALL_DIR
    Push-Location (Join-Path $INSTALL_DIR 'packages\shared')
    bun run typecheck
    Pop-Location
    bun run build
    Pop-Location

    Push-Location (Join-Path $INSTALL_DIR 'apps\desktop')
    bunx tauri build --bundles app
    Pop-Location

    # Find the newly built .exe
    $bundleDir = Join-Path $INSTALL_DIR 'apps\desktop\target\release\bundle\windows'
    if (-not (Test-Path $bundleDir)) {
        $bundleDir = Join-Path $INSTALL_DIR 'apps\desktop\target\release'
    }

    $exeFile = Get-ChildItem -Path $bundleDir -Filter 'Revv*.exe' -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch 'msi|wix|nsis' } |
        Select-Object -First 1

    if (-not $exeFile) {
        $exeFile = Get-ChildItem -Path (Join-Path $INSTALL_DIR 'apps\desktop\target') -Filter '*.exe' -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match 'Revv' } |
            Select-Object -First 1
    }

    if (-not $exeFile) {
        fail 'Build finished but no .exe was produced.'
    }

    # Replace the installed .exe
    $oldApp = Find-App
    $destDir = if ($oldApp) { Split-Path $oldApp -Parent } else { $env:LOCALAPPDATA\Revv }
    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    }
    $destApp = Join-Path $destDir $exeFile.Name

    # Remove stale old app if product name changed
    if ($oldApp -and $oldApp -ne $destApp -and (Test-Path $oldApp)) {
        info "Product name changed — removing stale $oldApp"
        Remove-Item $oldApp -Force
    }

    info 'Stopping Revv if running'
    if (Test-ScheduledTaskExists) {
        Stop-RevvServer
    }
    $procs = Get-Process -Name 'Revv*' -ErrorAction SilentlyContinue
    if ($procs) {
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1

    info "Replacing $destApp"
    if (Test-Path $destApp) { Remove-Item $destApp -Force }
    Copy-Item $exeFile.FullName $destApp

    # Re-source common.sh from freshly-pulled tree
    $newCommon = Join-Path $INSTALL_DIR 'scripts\lib\common.ps1'
    if (Test-Path $newCommon) {
        $global:__REVV_COMMON_LOADED__ = $false
        . $newCommon
    }

    info 'Refreshing Scheduled Task'
    $bunForTask = (Get-Command bun -ErrorAction SilentlyContinue)?.Source
    if (-not $bunForTask) {
        $bunForTask = "$env:USERPROFILE\.bun\bin\bun.exe"
    }
    if (-not (Test-Path $bunForTask)) {
        fail 'Cannot locate bun for the scheduled task.'
    }

    if (Test-CommandAvailable 'Write-ScheduledTask') {
        Stop-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
        Write-ScheduledTask `
            -TaskName $TASK_NAME `
            -BunBin $bunForTask `
            -ProjectRoot $INSTALL_DIR `
            -LogDir $LOG_DIR
        Start-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    } else {
        warn 'Write-ScheduledTask not found; keeping existing task'
        Restart-RevvServer
    }

    # Refresh the CLI itself + helper lib
    $cliSrc = Join-Path $INSTALL_DIR 'scripts\revv.ps1'
    if (Test-Path $cliSrc) {
        Copy-Item $cliSrc $CLI_PATH -Force
    }
    if (Test-Path $newCommon) {
        $cliLibDir = Join-Path (Split-Path $CLI_PATH -Parent) '..\share\revv'
        New-Item -ItemType Directory -Force -Path $cliLibDir | Out-Null
        Copy-Item $newCommon (Join-Path $cliLibDir 'common.ps1') -Force
    }

    $short = (Push-Location $INSTALL_DIR; git rev-parse --short HEAD; Pop-Location)
    success "Updated to $short"
    Start-Process $destApp -ErrorAction SilentlyContinue
}

function Cmd-Uninstall {
    step 'Uninstall Revv'

    $revvDataDir = "$env:USERPROFILE\.revv"
    $tauriAppSupport = "$env:LOCALAPPDATA\Revv"

    $prodDb = "$REVV_DB_PATH"

    Write-Host @"

${BOLD}This will permanently remove ALL Revv artifacts:${RESET}

  ${CYAN}Application${RESET}
    • Revv.exe (all copies in $env:LOCALAPPDATA\Revv and $env:ProgramFiles\Revv)

  ${CYAN}Background services${RESET}
    • Scheduled Task: $TASK_NAME

  ${CYAN}Data${RESET}
    • $prodDb (database + WAL/SHM)
    • $revvDataDir\ (git clones, worktrees, settings)

  ${CYAN}Configuration${RESET}
    • $REVV_SUPPORT_DIR\ (auth key, config, github.conf, source tree)
    • $LOG_DIR\ (server logs)

  ${CYAN}Tauri / WebView data${RESET}
    • $tauriAppSupport\

  ${CYAN}CLI${RESET}
    • $CLI_PATH
    • $env:USERPROFILE\.local\share\revv\

  ${CYAN}Shell config${RESET}
    • PATH entry added by the installer (in user Environment PATH)
"@

    if (-not (confirm 'Proceed with uninstall?')) {
        info 'Aborted.'
        return
    }

    # 1. Stop services
    info 'Stopping services...'
    if (Test-ScheduledTaskExists) {
        Stop-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName 'Server' -TaskPath 'Revv\' -Confirm:$false -ErrorAction SilentlyContinue
    }

    # Quit the app
    $procs = Get-Process -Name 'Revv*' -ErrorAction SilentlyContinue
    if ($procs) {
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1

    # 2. Remove the .exe bundle(s)
    foreach ($dir in @("$env:LOCALAPPDATA\Revv", "$env:ProgramFiles\Revv")) {
        if (Test-Path $dir) {
            Get-ChildItem -Path $dir -Filter 'Revv*.exe' -ErrorAction SilentlyContinue | ForEach-Object {
                Remove-Item $_.FullName -Force
                info "Removed $($_.FullName)"
            }
        }
    }

    # 3. Remove database files
    foreach ($f in @("$prodDb", "$prodDb-wal", "$prodDb-shm")) {
        if (Test-Path $f) { Remove-Item $f -Force }
    }
    # Also check repo root
    Push-Location $INSTALL_DIR -ErrorAction SilentlyContinue
    foreach ($f in @('.\revv.db', '.\revv.db-wal', '.\revv.db-shm')) {
        if (Test-Path $f) { Remove-Item $f -Force }
    }
    Pop-Location -ErrorAction SilentlyContinue

    # 4. Remove ~/.revv/ (repos, worktrees, settings)
    if (Test-Path $revvDataDir) {
        Remove-Item $revvDataDir -Recurse -Force
        info "Removed $revvDataDir (git clones, settings)"
    }

    # 5. Remove $env:APPDATA\Revv\ (auth key, config, source tree)
    if (Test-Path $REVV_SUPPORT_DIR) {
        Remove-Item $REVV_SUPPORT_DIR -Recurse -Force
        info "Removed $REVV_SUPPORT_DIR"
    }
    # Also remove source dir if overridden
    if ((Test-Path $INSTALL_DIR) -and (-not $INSTALL_DIR.StartsWith($REVV_SUPPORT_DIR))) {
        Remove-Item $INSTALL_DIR -Recurse -Force
        info "Removed $INSTALL_DIR"
    }

    # 6. Remove logs
    if (Test-Path $LOG_DIR) {
        Remove-Item $LOG_DIR -Recurse -Force
        info "Removed $LOG_DIR"
    }

    # 7. Remove Tauri / WebView data
    $tauriDirs = @(
        "$env:LOCALAPPDATA\Revv\WebView",
        "$env:LOCALAPPDATA\Revv\Cache",
        "$env:LOCALAPPDATA\Revv"
    )
    foreach ($d in $tauriDirs) {
        if (Test-Path $d) {
            Remove-Item $d -Recurse -Force
            info "Removed $d"
        }
    }

    # 8. Clean user PATH registry entry
    Remove-FromUserPath "$env:USERPROFILE\.local\bin"

    # 9. Remove CLI + shared helper
    if (Test-Path "$env:USERPROFILE\.local\share\revv\common.ps1") {
        Remove-Item "$env:USERPROFILE\.local\share\revv\common.ps1" -Force
    }
    $shareDir = "$env:USERPROFILE\.local\share\revv"
    if (Test-Path $shareDir) {
        Remove-Item $shareDir -Force -ErrorAction SilentlyContinue
    }

    # Remove self — do this last
    if (Test-Path $CLI_PATH) {
        Remove-Item $CLI_PATH -Force
    }

    Write-Host ''
    success 'Revv has been completely uninstalled.'
    info 'Bun and the Rust toolchain were left installed — remove them manually if no longer needed.'
    info '  bun:   Remove-Item $env:USERPROFILE\.bun -Recurse -Force'
    info '  rust:  rustup self uninstall'
}

function Cmd-Doctor {
    step 'Revv doctor'
    $issues = 0

    if (Test-Path "$INSTALL_DIR\.git") { success 'Source tree present' } else { warn "Source tree missing: $INSTALL_DIR"; $issues++ }
    if (Find-App) { success "Revv.exe installed: $(Find-App)" } else { warn 'Revv.exe not found'; $issues++ }
    if (Test-ScheduledTaskExists) { success 'Scheduled task installed' } else { warn 'Scheduled task missing'; $issues++ }
    if (check-cmd bun) { success "bun $(bun --version)" } else { warn 'bun not on PATH'; $issues++ }
    if (check-cmd cargo) { success "cargo $((cargo --version).Split(' ')[1])" } else { warn 'cargo not on PATH'; $issues++ }
    if (Test-ServerRunning) { success "API server responding on $API_URL" } else { warn "API server not responding — try 'revv restart'"; $issues++ }

    # Auth key check
    if (Test-Path $REVV_AUTH_KEY) {
        success 'Auth key present'
    } else {
        warn "Auth key missing at $REVV_AUTH_KEY — server will create it on next start"
        $issues++
    }

    Write-Host ''
    if ($issues -eq 0) {
        Write-Host "${BOLD}${GREEN}  ✓  All checks passed${RESET}"
    } else {
        Write-Host "${BOLD}${YELLOW}  ✗  $issues issue(s) found${RESET}"
        exit 1
    }
}

# ── Dispatch ─────────────────────────────────────────────────
switch ($Command) {
    'update'     { Cmd-Update }
    'uninstall'  { Cmd-Uninstall }
    'start'      { Cmd-Start }
    'stop'       { Cmd-Stop }
    'restart'    { Cmd-Restart }
    'status'     { Cmd-Status }
    'logs'       { Cmd-Logs }
    'open'       { Cmd-Open }
    'doctor'     { Cmd-Doctor }
    'path'       { Cmd-Path }
    { $_ -in 'help', '-h', '--help' } { Cmd-Help }
    default {
        Write-Host "Unknown command: $Command" -ForegroundColor Red
        Cmd-Help
        exit 2
    }
}
