# shellcheck shell=bash
# ──────────────────────────────────────────────────────────────
# Revv — Shared shell helpers (sourced by install.sh and scripts/revv)
#
# This file is intentionally NOT executable and has no shebang — it's meant
# to be loaded with `source`. It provides colors, logging helpers, TTY-safe
# prompts, platform detection, and toolchain-install routines that both the
# installer and the management CLI use.
# ──────────────────────────────────────────────────────────────

# ── Double-source guard ───────────────────────────────────────
if [[ -n "${__REVV_COMMON_LOADED__:-}" ]]; then
  return 0 2>/dev/null || true
fi
__REVV_COMMON_LOADED__=1

# ── Colors (only when stdout is a TTY) ────────────────────────
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

# Legacy short aliases — existing scripts reference $RED, $GREEN, etc.
RED="$REVV_RED"
GREEN="$REVV_GREEN"
YELLOW="$REVV_YELLOW"
BLUE="$REVV_BLUE"
CYAN="$REVV_CYAN"
BOLD="$REVV_BOLD"
DIM="$REVV_DIM"
RESET="$REVV_RESET"

# ── Logging ───────────────────────────────────────────────────
info()    { printf "%s[info]%s  %s\n" "$REVV_BLUE"   "$REVV_RESET" "$*"; }
success() { printf "%s[  ok]%s  %s\n" "$REVV_GREEN"  "$REVV_RESET" "$*"; }
warn()    { printf "%s[warn]%s  %s\n" "$REVV_YELLOW" "$REVV_RESET" "$*"; }
fail()    { printf "%s[FAIL]%s  %s\n" "$REVV_RED"    "$REVV_RESET" "$*" >&2; exit 1; }
step()    { printf "\n%s%s▸ %s%s\n"  "$REVV_BOLD" "$REVV_CYAN" "$*" "$REVV_RESET"; }

# ── TTY-safe input (works under `curl … | bash`) ──────────────
#
# Reads from /dev/tty so prompts work even when stdin is the pipe carrying
# the script itself. `read_tty VAR PROMPT [DEFAULT] [silent]`.
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

# ── Platform detection ────────────────────────────────────────
#
# Sets globals: PLATFORM (macos|linux), ARCH (raw uname -m),
# RUST_TARGET (aarch64-apple-darwin, x86_64-unknown-linux-gnu, …).
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) PLATFORM="macos" ;;
    Linux)  PLATFORM="linux" ;;
    *)      fail "Unsupported OS: $os" ;;
  esac
  ARCH="$arch"
  if [[ "$PLATFORM" == "macos" ]]; then
    if [[ "$ARCH" == "arm64" || "$ARCH" == "aarch64" ]]; then
      RUST_TARGET="aarch64-apple-darwin"
    else
      RUST_TARGET="x86_64-apple-darwin"
    fi
  else
    if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
      RUST_TARGET="aarch64-unknown-linux-gnu"
    else
      RUST_TARGET="x86_64-unknown-linux-gnu"
    fi
  fi
  export PLATFORM ARCH RUST_TARGET
}

# ── Canonical paths ───────────────────────────────────────────
#
# Sets globals: REVV_SUPPORT_DIR, REVV_SRC_DIR, REVV_LOG_DIR,
# REVV_LAUNCH_AGENT_PLIST, REVV_CLI_DIR, REVV_AUTH_KEY.
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
    linux)
      REVV_SUPPORT_DIR="${REVV_SUPPORT_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/revv}"
      REVV_LOG_DIR="${REVV_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/revv/logs}"
      REVV_LAUNCH_AGENT_PLIST="${REVV_LAUNCH_AGENT_PLIST:-}"
      ;;
    *)
      REVV_SUPPORT_DIR="${REVV_SUPPORT_DIR:-$HOME/.revv}"
      REVV_LOG_DIR="${REVV_LOG_DIR:-$HOME/.revv/logs}"
      REVV_LAUNCH_AGENT_PLIST="${REVV_LAUNCH_AGENT_PLIST:-}"
      ;;
  esac
  REVV_SRC_DIR="${REVV_INSTALL_DIR:-$REVV_SUPPORT_DIR/src}"
  REVV_CLI_DIR="${REVV_CLI_DIR:-$HOME/.local/bin}"
  REVV_AUTH_KEY="${REVV_AUTH_KEY:-$REVV_SUPPORT_DIR/auth.key}"
  export REVV_SUPPORT_DIR REVV_SRC_DIR REVV_LOG_DIR
  export REVV_LAUNCH_AGENT_PLIST REVV_CLI_DIR REVV_AUTH_KEY
}

# ── Auth key management ───────────────────────────────────────
#
# Creates $REVV_AUTH_KEY (64 hex chars) mode 600 in a dir mode 700 if it
# doesn't exist. No-op if already present and non-empty. The server reads
# this file at startup (see apps/server/src/auth.ts loadOrCreateAuthSecret).
ensure_auth_key() {
  revv_paths
  if [[ -s "$REVV_AUTH_KEY" ]]; then
    success "Auth key already present"
    return 0
  fi
  mkdir -p "$REVV_SUPPORT_DIR"
  chmod 700 "$REVV_SUPPORT_DIR" 2>/dev/null || true
  local secret=""
  if check_cmd openssl; then
    secret="$(openssl rand -hex 32)"
  elif check_cmd xxd; then
    secret="$(head -c 32 /dev/urandom | xxd -p -c 32)"
  else
    secret="$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 64)"
  fi
  if [[ ${#secret} -lt 32 ]]; then
    fail "Could not generate an auth key (no openssl/xxd/urandom available)"
  fi
  printf '%s' "$secret" > "$REVV_AUTH_KEY"
  chmod 600 "$REVV_AUTH_KEY"
  success "Generated auth key at $REVV_AUTH_KEY"
}

# ── Toolchain installers ──────────────────────────────────────

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
  if [[ "${PLATFORM:-}" == "macos" ]]; then
    fail "git not found. It should ship with Xcode CLT — re-run 'xcode-select --install'."
  fi
  fail "git not found. Install it from https://git-scm.com and re-run."
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
  # Pick up cargo if it was just installed in this shell
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

  # Rust target
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
