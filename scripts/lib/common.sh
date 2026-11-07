# shellcheck shell=bash
# Shared shell helpers, sourced (not executed) by install.sh and scripts/revv.

if [[ -n "${__REVV_COMMON_LOADED__:-}" ]]; then
  return 0 2>/dev/null || true
fi
__REVV_COMMON_LOADED__=1

if [[ -t 1 ]]; then
  REVV_RED=$'\033[0;31m'
  REVV_GREEN=$'\033[0;32m'
  REVV_YELLOW=$'\033[1;33m'
  REVV_BLUE=$'\033[0;34m'
  REVV_CYAN=$'\033[0;36m'
  REVV_BOLD=$'\033[1m'
  REVV_DIM=$'\033[2m'
  REVV_RESET=$'\033[0m'
else
  REVV_RED="" REVV_GREEN="" REVV_YELLOW="" REVV_BLUE="" REVV_CYAN=""
  REVV_BOLD="" REVV_DIM="" REVV_RESET=""
fi

# Short aliases used by scripts/revv.
RED="$REVV_RED"
GREEN="$REVV_GREEN"
YELLOW="$REVV_YELLOW"
BLUE="$REVV_BLUE"
CYAN="$REVV_CYAN"
BOLD="$REVV_BOLD"
DIM="$REVV_DIM"
RESET="$REVV_RESET"

info()    { printf "  %s·%s  %s\n"        "$REVV_CYAN"   "$REVV_RESET" "$*"; }
success() { printf "  %s✓%s  %s\n"        "$REVV_GREEN"  "$REVV_RESET" "$*"; }
warn()    { printf "  %s⚠%s  %s\n"        "$REVV_YELLOW" "$REVV_RESET" "$*"; }
fail()    { printf "\n  %s✗%s  %s\n\n"    "$REVV_RED"    "$REVV_RESET" "$*" >&2; exit 1; }
step()    { printf "\n  %s%s▸%s  %s\n\n" "$REVV_BOLD" "$REVV_CYAN" "$REVV_RESET" "$*"; }

banner() {
  printf "\n"
  printf "  %s%s██████╗ ███████╗██╗   ██╗██╗   ██╗%s\n" "$REVV_CYAN" "$REVV_BOLD" "$REVV_RESET"
  printf "  %s%s██╔══██╗██╔════╝██║   ██║██║   ██║%s\n" "$REVV_CYAN" "$REVV_BOLD" "$REVV_RESET"
  printf "  %s%s██████╔╝█████╗  ██║   ██║██║   ██║%s\n" "$REVV_CYAN" "$REVV_BOLD" "$REVV_RESET"
  printf "  %s%s██╔══██╗██╔══╝  ╚██╗ ██╔╝╚██╗ ██╔╝%s\n" "$REVV_CYAN" "$REVV_BOLD" "$REVV_RESET"
  printf "  %s%s██║  ██║███████╗ ╚████╔╝  ╚████╔╝ %s\n"  "$REVV_CYAN" "$REVV_BOLD" "$REVV_RESET"
  printf "  %s%s╚═╝  ╚═╝╚══════╝  ╚═══╝    ╚═══╝  %s\n" "$REVV_CYAN" "$REVV_BOLD" "$REVV_RESET"
  printf "\n  %sAI-powered code review%s\n\n" "$REVV_DIM" "$REVV_RESET"
}

_REVV_SP_FRAMES='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
_REVV_SP_MSG=''
_REVV_SP_PID=''

spin_start() {
  _REVV_SP_MSG="$1"
  if [[ ! -t 1 ]]; then printf "  ···  %s\n" "$_REVV_SP_MSG"; return; fi
  printf '\033[?25l'
  (
    local i=0
    while true; do
      printf "\r  %s%s%s  %s  " \
        "$REVV_CYAN" "${_REVV_SP_FRAMES:$((i % 10)):1}" "$REVV_RESET" "$_REVV_SP_MSG"
      i=$((i + 1)); sleep 0.07
    done
  ) &
  _REVV_SP_PID=$!
  disown "$_REVV_SP_PID" 2>/dev/null
}

spin_stop() {
  local ok="${1:-1}"
  if [[ -n "$_REVV_SP_PID" ]]; then
    kill "$_REVV_SP_PID" 2>/dev/null
    wait "$_REVV_SP_PID" 2>/dev/null
    _REVV_SP_PID=''
  fi
  if [[ ! -t 1 ]]; then return; fi
  printf '\033[?25h'
  if [[ "$ok" -eq 1 ]]; then
    printf "\r  %s✓%s  %-50s\n" "$REVV_GREEN" "$REVV_RESET" "$_REVV_SP_MSG"
  else
    printf "\r  %s✗%s  %-50s\n" "$REVV_RED"   "$REVV_RESET" "$_REVV_SP_MSG"
  fi
}

# run_quiet LABEL CMD [ARGS...]: spinner while output goes to a temp log
# (REVV_VERBOSE=1 streams it instead); exits on failure.
run_quiet() {
  local label="$1"; shift
  local _log _rc

  if [[ "${REVV_VERBOSE:-0}" == "1" ]]; then
    printf "\n  %s%s▸%s  %s\n\n" "$REVV_BOLD" "$REVV_CYAN" "$REVV_RESET" "$label"
    "$@" 2>&1 | sed 's/^/    /'
    _rc="${PIPESTATUS[0]}"
    if [[ "$_rc" -eq 0 ]]; then
      success "$label"
      return 0
    else
      fail "Command failed (exit $_rc): $*"
    fi
  fi

  _log="$(mktemp)"
  spin_start "$label"
  if "$@" >"$_log" 2>&1; then
    spin_stop 1
    rm -f "$_log"
    return 0
  fi
  _rc=$?
  spin_stop 0
  printf "\n  %s✗%s  Command failed (exit %d): %s\n" \
    "$REVV_RED" "$REVV_RESET" "$_rc" "$*" >&2
  printf "  %s→%s  Log: %s\n" "$REVV_DIM" "$REVV_RESET" "$_log" >&2
  printf "  %sLast output:%s\n" "$REVV_DIM" "$REVV_RESET" >&2
  tail -n 15 "$_log" | sed 's/^/    /' >&2
  printf "\n" >&2
  exit 1
}

# read_tty VAR PROMPT [DEFAULT] [silent]. Reads /dev/tty: under
# `curl … | bash`, stdin is the pipe carrying the script.
read_tty() {
  local __varname="$1" __prompt="$2" __default="${3:-}" __silent="${4:-}"
  if [[ "${REVV_AUTO_YES:-0}" == "1" && -n "$__default" ]]; then
    printf -v "$__varname" '%s' "$__default"
    return 0
  fi
  printf "%s  → %s%s%s " "$REVV_YELLOW" "$__prompt" \
    "$([[ -n "$__default" ]] && printf ' [%s]' "$__default")" "$REVV_RESET"
  local __reply
  if [[ "$__silent" == "silent" ]]; then
    read -r -s __reply </dev/tty; printf "\n"
  else
    read -r __reply </dev/tty
  fi
  [[ -z "$__reply" && -n "$__default" ]] && __reply="$__default"
  printf -v "$__varname" '%s' "$__reply"
}

confirm() {
  if [[ "${REVV_AUTO_YES:-0}" == "1" ]]; then return 0; fi
  local reply
  read_tty reply "$1 [Y/n]" "Y"
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

check_cmd() { command -v "$1" >/dev/null 2>&1; }

# Sets and exports PLATFORM, ARCH (raw uname -m) and RUST_TARGET.
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  [[ "$os" == "Darwin" ]] || fail "Unsupported OS: $os (Revv is macOS-only)"
  PLATFORM="macos"
  ARCH="$arch"
  if [[ "$ARCH" == "arm64" || "$ARCH" == "aarch64" ]]; then
    RUST_TARGET="aarch64-apple-darwin"
  else
    RUST_TARGET="x86_64-apple-darwin"
  fi
  export PLATFORM ARCH RUST_TARGET
}

# Sets and exports REVV_SUPPORT_DIR, REVV_SRC_DIR, REVV_LOG_DIR,
# REVV_LAUNCH_AGENT_PLIST, REVV_CLI_DIR.
revv_paths() {
  : "${PLATFORM:=$(uname -s)}"
  # bash 3.2 (macOS /bin/bash) lacks ${VAR,,}; lowercase via tr.
  local __platform_lc
  __platform_lc="$(printf '%s' "$PLATFORM" | tr '[:upper:]' '[:lower:]')"
  case "$__platform_lc" in
    macos|darwin)
      REVV_SUPPORT_DIR="${REVV_SUPPORT_DIR:-$HOME/Library/Application Support/Revv}"
      REVV_LOG_DIR="${REVV_LOG_DIR:-$HOME/Library/Logs/Revv}"
      REVV_LAUNCH_AGENT_PLIST="${REVV_LAUNCH_AGENT_PLIST:-$HOME/Library/LaunchAgents/com.revv.server.plist}"
      ;;
    *)
      fail "Unsupported platform: $__platform_lc (Revv is macOS-only)"
      ;;
  esac
  REVV_SRC_DIR="${REVV_INSTALL_DIR:-$REVV_SUPPORT_DIR/src}"
  REVV_CLI_DIR="${REVV_CLI_DIR:-$HOME/.local/bin}"
  export REVV_SUPPORT_DIR REVV_SRC_DIR REVV_LOG_DIR
  export REVV_LAUNCH_AGENT_PLIST REVV_CLI_DIR
}

ensure_xcode_clt() {
  [[ "${PLATFORM:-}" == "macos" ]] || return 0
  if xcode-select -p >/dev/null 2>&1; then
    success "Xcode Command Line Tools present"
    return 0
  fi
  warn "Xcode Command Line Tools are required."
  if confirm "Trigger the Apple installer dialog now?"; then
    xcode-select --install >/dev/null 2>&1 || true
    info "A system dialog has opened. Click Install, accept the license, and wait for it to finish."
    info "Press Enter here once the installation completes…"
    read -r _ </dev/tty || true
    xcode-select -p >/dev/null 2>&1 \
      || fail "Xcode CLT still missing. Install manually and re-run."
    success "Xcode CLT installed"
  else
    fail "Xcode CLT is required. Install with: xcode-select --install"
  fi
}

ensure_git() {
  if check_cmd git; then
    success "git $(git --version | awk '{print $3}')"
    return 0
  fi
  fail "git not found. It should ship with Xcode CLT — re-run 'xcode-select --install'."
}

ensure_bun() {
  local required_major=1 required_minor=3
  if check_cmd bun; then
    local v major minor
    v="$(bun --version)"
    major="$(echo "$v" | cut -d. -f1)"
    minor="$(echo "$v" | cut -d. -f2)"
    if [[ "$major" -gt "$required_major" ]] \
       || [[ "$major" -eq "$required_major" && "$minor" -ge "$required_minor" ]]; then
      success "bun $v"
      return 0
    fi
    warn "bun $v is older than $required_major.$required_minor"
    confirm "Upgrade Bun?" || { warn "Keeping old Bun — build may fail"; return 0; }
  else
    warn "Bun not found"
    confirm "Install Bun from https://bun.sh?" || fail "Bun is required."
  fi
  info "Installing Bun…"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  check_cmd bun || fail "Bun install reported success but 'bun' is not on PATH."
  success "bun $(bun --version)"
}

ensure_rust() {
  [[ -f "$HOME/.cargo/env" ]] && { # shellcheck disable=SC1091
    source "$HOME/.cargo/env"; }

  if check_cmd rustc && check_cmd cargo; then
    success "rustc $(rustc --version | awk '{print $2}')"
  else
    warn "Rust toolchain not found"
    confirm "Install Rust via rustup (https://rustup.rs)?" \
      || fail "Rust is required to build the Tauri desktop shell."
    info "Installing Rust via rustup…"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
    check_cmd cargo || fail "Rust installation failed — rustup not in PATH. Try: source \$HOME/.cargo/env"
    success "rustc $(rustc --version | awk '{print $2}')"
  fi

  : "${RUST_TARGET:?detect_platform must run before ensure_rust}"
  if check_cmd rustup; then
    if rustup target list --installed 2>/dev/null | grep -q "^$RUST_TARGET$"; then
      success "Rust target $RUST_TARGET"
    else
      warn "Rust target $RUST_TARGET is not installed"
      if confirm "Add Rust target $RUST_TARGET?"; then
        rustup target add "$RUST_TARGET"
        success "Rust target $RUST_TARGET"
      else
        warn "Missing Rust target — Tauri build may fail"
      fi
    fi
  else
    local host
    host="$(rustc -vV 2>/dev/null | awk '/^host:/ {print $2}' || true)"
    if [[ -n "$host" && "$host" == "$RUST_TARGET" ]]; then
      success "Rust target $RUST_TARGET (native host, rustup not required)"
    else
      warn "rustup not found; can't add target '$RUST_TARGET' (host is '${host:-unknown}')"
    fi
  fi
}

revv_sha256_of() {
  if check_cmd sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

install_release_app() {
  local release_tag="$1" app_dir="${2:-}" asset_arch asset_name release_json bundle_url bundle_sha
  local sums_file bundle_file actual_sha extract_dir app_source install_dir installed_app tmp_app backup_app

  REVV_INSTALLED_APP=""
  [[ -n "$release_tag" ]] || return 1
  case "$(uname -m)" in
    arm64|aarch64) asset_arch="aarch64" ;;
    x86_64)        asset_arch="x64" ;;
    *)             return 1 ;;
  esac
  # The updater archive: the release's only copy of the app.
  asset_name="Revv_${asset_arch}.app.tar.gz"

  release_json="$(mktemp)"
  curl -fsSL \
    "https://api.github.com/repos/${REVV_GITHUB_REPO}/releases/tags/${release_tag}" \
    -o "$release_json" || { rm -f "$release_json"; return 1; }

  bundle_url="$(sed -n "s/.*\"browser_download_url\": \"\([^\"]*\/${asset_name//./\\.}\)\".*/\1/p" "$release_json" | head -1)"
  bundle_sha="$(sed -n "/\"name\": \"${asset_name//./\\.}\"/,/\"browser_download_url\"/ s/.*\"digest\": *\"sha256:\([a-fA-F0-9]*\)\".*/\1/p" "$release_json" | head -1)"
  rm -f "$release_json"
  [[ -n "$bundle_url" ]] || return 1

  if [[ -z "$bundle_sha" ]]; then
    sums_file="$(mktemp)"
    if curl -fsSL "https://github.com/${REVV_GITHUB_REPO}/releases/download/${release_tag}/SHA256SUMS" -o "$sums_file" 2>/dev/null; then
      bundle_sha="$(awk -v name="$asset_name" '$2 == name {print $1}' "$sums_file" | head -1)"
    fi
    rm -f "$sums_file"
  fi

  bundle_file="$(mktemp)"
  spin_start "Downloading Revv.app from ${release_tag} (${asset_arch})"
  if ! curl -fsSL "$bundle_url" -o "$bundle_file"; then
    spin_stop 0
    rm -f "$bundle_file"
    return 1
  fi
  spin_stop 1

  if [[ -n "$bundle_sha" ]]; then
    actual_sha="$(revv_sha256_of "$bundle_file")"
    if [[ "$actual_sha" != "$bundle_sha" ]]; then
      rm -f "$bundle_file"
      fail "Downloaded app archive checksum mismatch for ${release_tag}."
    fi
  else
    warn "No checksum published for ${release_tag}; installing without checksum verification."
  fi

  extract_dir="$(mktemp -d)"
  tar -xzf "$bundle_file" -C "$extract_dir" || {
    rm -rf "$extract_dir" "$bundle_file"
    return 1
  }
  rm -f "$bundle_file"

  app_source="$(find "$extract_dir" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -1)"
  if [[ -z "$app_source" ]]; then
    rm -rf "$extract_dir"
    return 1
  fi

  install_dir="${app_dir:-/Applications}"
  [[ -w "$install_dir" ]] || install_dir="$HOME/Applications"
  mkdir -p "$install_dir" || {
    rm -rf "$extract_dir"
    return 1
  }
  installed_app="$install_dir/$(basename "$app_source")"
  tmp_app="${installed_app}.tmp.$$"

  rm -rf "$tmp_app" || {
    rm -rf "$extract_dir"
    return 1
  }
  if ! mv "$app_source" "$tmp_app"; then
    rm -rf "$tmp_app" "$extract_dir"
    return 1
  fi
  rm -rf "$extract_dir"
  xattr -cr "$tmp_app" 2>/dev/null || true

  backup_app=""
  if [[ -e "$installed_app" ]]; then
    quit_revv_app "$installed_app"
    backup_app="${installed_app}.backup.$$"
    if ! rm -rf "$backup_app" || ! mv "$installed_app" "$backup_app"; then
      rm -rf "$tmp_app"
      return 1
    fi
  fi
  if ! mv "$tmp_app" "$installed_app"; then
    rm -rf "$tmp_app"
    if [[ -n "$backup_app" ]]; then
      mv "$backup_app" "$installed_app" 2>/dev/null || true
    fi
    return 1
  fi
  if [[ -n "$backup_app" ]]; then
    rm -rf "$backup_app" || warn "Installed app, but could not remove backup: $backup_app"
  fi

  REVV_INSTALLED_APP="$installed_app"
}

quit_revv_app() {
  local app_path="$1" executable pid command pids="" deadline
  [[ -d "$app_path" ]] || return 0
  executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app_path/Contents/Info.plist")" \
    || fail "Cannot read Revv executable from $app_path"
  while read -r pid command; do
    [[ "$command" == "$app_path/Contents/MacOS/$executable" ]] && pids+=" $pid"
  done < <(ps -axo pid=,comm=)
  osascript -e 'on run argv' -e 'tell application (item 1 of argv) to quit' \
    -e 'end run' "$app_path" 2>/dev/null || true
  deadline=$((SECONDS + 15))
  for pid in $pids; do
    while kill -0 "$pid" 2>/dev/null && (( SECONDS < deadline )); do sleep 0.2; done
    kill -0 "$pid" 2>/dev/null && fail "Revv did not quit. Quit the app and retry."
  done
  return 0
}

# Prints KEY's value from a .env-style file, surrounding quotes stripped, or
# nothing if absent.
_revv_dotenv_get() {
  local key="$1" env_file="$2"
  [[ -f "$env_file" ]] || return 0
  local line value
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*${key}= ]] || continue
    value="${line#*=}"
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    printf '%s' "$value"
    return 0
  done < "$env_file"
}

# Record the user's tool locations for Finder/login launches, which lack shell setup.
write_desktop_server_config() {
  local config_path="$1" bun_bin="$2" project_root="$3" log_dir="$4"
  local legacy_path="${5:-$HOME/Library/LaunchAgents/com.revv.server.plist}"
  [[ -x "$bun_bin" ]] || fail "Bun is missing or not executable: $bun_bin"
  [[ -f "$project_root/apps/server/src/index.ts" ]] || fail "Revv server source is missing: $project_root"
  local claude_bin opencode_bin codex_bin candidate
  claude_bin="$(command -v claude 2>/dev/null || true)"
  opencode_bin="$(command -v opencode 2>/dev/null || true)"
  codex_bin="$(command -v codex 2>/dev/null || true)"
  if [[ -z "$codex_bin" ]]; then
    for candidate in "/Applications/ChatGPT.app/Contents/Resources/codex" "$HOME/Applications/ChatGPT.app/Contents/Resources/codex"; do
      if [[ -x "$candidate" ]]; then codex_bin="$candidate"; break; fi
    done
  fi
  local github_host="${REVV_GITHUB_HOST:-}" github_client_id="${REVV_GITHUB_CLIENT_ID:-}"
  [[ -n "$github_host" ]] || github_host="$(_revv_dotenv_get GITHUB_HOST "$REVV_SUPPORT_DIR/github.conf")"
  [[ -n "$github_client_id" ]] || github_client_id="$(_revv_dotenv_get GITHUB_CLIENT_ID "$REVV_SUPPORT_DIR/github.conf")"
  [[ -n "$github_host" ]] || github_host="$(_revv_dotenv_get GITHUB_HOST "$project_root/apps/server/.env")"
  [[ -n "$github_client_id" ]] || github_client_id="$(_revv_dotenv_get GITHUB_CLIENT_ID "$project_root/apps/server/.env")"

  "$bun_bin" --no-env-file -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [target, executable, projectRoot, logDir, supportDir, claude, opencode, codex, host, clientId, legacy] = process.argv.slice(1);
    let previousEnv = {};
    // legacy-upgrade: launchAgent (the app migrates it too, in server_config.rs).
    if (fs.existsSync(legacy)) {
      const migrated = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", legacy]);
      if (migrated.exitCode !== 0) throw new Error("Cannot read legacy Revv server configuration");
      previousEnv = JSON.parse(migrated.stdout.toString()).EnvironmentVariables;
    }
    try { previousEnv = { ...previousEnv, ...JSON.parse(fs.readFileSync(target, "utf8")).env }; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      REVV_CHANNEL: "prod",
      PORT: "45678",
      REVV_DB_PATH: path.join(supportDir, "revv.db"),
      ...previousEnv,
      REVV_CLAUDE_BIN: claude || previousEnv.REVV_CLAUDE_BIN || "",
      REVV_OPENCODE_BIN: opencode || previousEnv.REVV_OPENCODE_BIN || "",
      REVV_CODEX_BIN: codex || previousEnv.REVV_CODEX_BIN || "",
    };
    if (host) env.GITHUB_HOST = host;
    if (clientId) env.GITHUB_CLIENT_ID = clientId;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = target + "." + process.pid + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify({ executable, projectRoot, logDir, env }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, target);
  ' "$config_path" "$bun_bin" "$project_root" "$log_dir" "$REVV_SUPPORT_DIR" \
    "$claude_bin" "$opencode_bin" "$codex_bin" "$github_host" "$github_client_id" "$legacy_path"
}

retire_server_launch_agent() {
  local plist_path="$1"
  if [[ -f "$plist_path" ]]; then
    launchctl unload -w "$plist_path" 2>/dev/null || true
    rm -f "$plist_path"
  fi
}
