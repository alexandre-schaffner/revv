#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────
# Revv — Developer Environment Setup
# Makes `bun run dev:desktop` work flawlessly from a clean machine.
#
# Usage:
#   ./install.sh              Interactive mode (prompts before actions)
#   ./install.sh --yes        Non-interactive, auto-approve all installs
#   ./install.sh --skip-env   Skip GitHub OAuth credential setup
#   ./install.sh --ci         --yes + --skip-env (for CI pipelines)
# ──────────────────────────────────────────────────────────────

REQUIRED_BUN_MAJOR=1
REQUIRED_BUN_MINOR=3
AUTO_YES=false
SKIP_ENV=false

# ── Colors & helpers ──────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# Track what passed/failed for the summary
PASSED=()
FAILED=()
WARNED=()

info()    { printf "${BLUE}[info]${RESET}  %s\n" "$*"; }
success() { printf "${GREEN}[  ok]${RESET}  %s\n" "$*"; }
warn()    { printf "${YELLOW}[warn]${RESET}  %s\n" "$*"; }
fail()    { printf "${RED}[FAIL]${RESET}  %s\n" "$*" >&2; exit 1; }
step()    { printf "\n${BOLD}${CYAN}▸ %s${RESET}\n" "$*"; }

pass()  { PASSED+=("$1");  success "$1"; }
miss()  { FAILED+=("$1");  warn "MISSING: $1"; }
caution() { WARNED+=("$1"); warn "$1"; }

confirm() {
  if $AUTO_YES; then return 0; fi
  printf "${YELLOW}  → %s [Y/n] ${RESET}" "$1"
  read -r reply </dev/tty
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

prompt_value() {
  # Usage: prompt_value "Label" "ENV_VAR_NAME"
  local label="$1" varname="$2" value=""
  printf "${YELLOW}  → Enter %s: ${RESET}" "$label"
  read -r value </dev/tty
  echo "$value"
}

check_command() {
  command -v "$1" &>/dev/null
}

# ── Parse args ────────────────────────────────────────────────

for arg in "$@"; do
  case "$arg" in
    --yes|-y)       AUTO_YES=true ;;
    --skip-env)     SKIP_ENV=true ;;
    --ci)           AUTO_YES=true; SKIP_ENV=true ;;
    --help|-h)
      echo "Usage: ./install.sh [options]"
      echo ""
      echo "Options:"
      echo "  --yes, -y     Non-interactive mode (auto-approve all installs)"
      echo "  --skip-env    Skip GitHub OAuth credential setup"
      echo "  --ci          Alias for --yes --skip-env (for CI pipelines)"
      echo "  --help, -h    Show this help message"
      exit 0
      ;;
  esac
done

# ── Header ────────────────────────────────────────────────────

printf "\n${BOLD}"
printf "  ┌─────────────────────────────────────┐\n"
printf "  │      Revv — Development Setup       │\n"
printf "  │       AI-Powered Code Review        │\n"
printf "  └─────────────────────────────────────┘\n"
printf "${RESET}\n"

# ── Move to project root ──────────────────────────────────────

cd "$(dirname "$0")"
PROJECT_ROOT="$(pwd)"
info "Project root: $PROJECT_ROOT"

# ── 1. Detect platform ────────────────────────────────────────

step "Detecting platform"

OS="$(uname -s)"
ARCH="$(uname -m)"
info "Platform: $OS / $ARCH"

case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *)      fail "Unsupported OS: $OS. Use install.ps1 for Windows." ;;
esac

# Determine the expected Rust target triple
if [[ "$PLATFORM" == "macos" ]]; then
  if [[ "$ARCH" == "arm64" ]]; then
    RUST_TARGET="aarch64-apple-darwin"
  else
    RUST_TARGET="x86_64-apple-darwin"
  fi
elif [[ "$PLATFORM" == "linux" ]]; then
  if [[ "$ARCH" == "aarch64" ]]; then
    RUST_TARGET="aarch64-unknown-linux-gnu"
  else
    RUST_TARGET="x86_64-unknown-linux-gnu"
  fi
fi
pass "Platform: $OS $ARCH → target $RUST_TARGET"

# ── 2. Git ────────────────────────────────────────────────────

step "Checking git"

if check_command git; then
  pass "git $(git --version | awk '{print $3}')"
else
  fail "git is not installed. Install it from https://git-scm.com and re-run."
fi

# ── 3. System build dependencies ─────────────────────────────

step "Checking system build dependencies"

if [[ "$PLATFORM" == "macos" ]]; then
  if xcode-select -p &>/dev/null; then
    pass "Xcode Command Line Tools"
  else
    warn "Xcode Command Line Tools not found"
    if confirm "Install Xcode Command Line Tools now?"; then
      xcode-select --install &>/dev/null || true
      printf "\n"
      info "A dialog has opened to install Xcode CLT."
      info "Please complete the installation, then press Enter to continue."
      read -r _ </dev/tty
      if xcode-select -p &>/dev/null; then
        pass "Xcode Command Line Tools"
      else
        fail "Xcode CLT still not found. Please install manually and re-run."
      fi
    else
      fail "Xcode Command Line Tools are required to build Tauri on macOS."
    fi
  fi

elif [[ "$PLATFORM" == "linux" ]]; then
  MISSING_PKGS=()

  if ! check_command pkg-config; then
    MISSING_PKGS+=("pkg-config")
  fi

  # Check for Tauri-required libraries (only if pkg-config is available)
  if check_command pkg-config; then
    REQUIRED_LIBS=("webkit2gtk-4.1" "gtk+-3.0" "openssl")
    for lib in "${REQUIRED_LIBS[@]}"; do
      if ! pkg-config --exists "$lib" 2>/dev/null; then
        MISSING_PKGS+=("$lib")
      fi
    done
  fi

  if [[ ${#MISSING_PKGS[@]} -eq 0 ]]; then
    pass "Linux system libraries (webkit2gtk, gtk3, openssl)"
  else
    warn "Missing system packages: ${MISSING_PKGS[*]}"
    info "Required packages for Tauri on Ubuntu/Debian:"
    echo ""
    echo "    sudo apt update && sudo apt install -y \\"
    echo "      build-essential curl wget file \\"
    echo "      libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev \\"
    echo "      librsvg2-dev patchelf libayatana-appindicator3-dev"
    echo ""
    if check_command apt; then
      if confirm "Install missing packages via apt now?"; then
        sudo apt update
        sudo apt install -y \
          build-essential curl wget file \
          libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev \
          librsvg2-dev patchelf libayatana-appindicator3-dev
        pass "Linux system packages"
      else
        caution "Skipped system packages — Tauri build may fail"
      fi
    else
      info "On Fedora/RHEL:"
      echo "    sudo dnf install -y openssl-devel gtk3-devel webkit2gtk4.1-devel \\"
      echo "      librsvg2-devel patchelf libappindicator-gtk3-devel"
      caution "Install the packages above manually, then re-run this script"
    fi
  fi
fi

# ── 4. Bun ────────────────────────────────────────────────────

step "Checking Bun runtime"

install_bun() {
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
}

if check_command bun; then
  BUN_VERSION="$(bun --version)"
  BUN_MAJOR="$(echo "$BUN_VERSION" | cut -d. -f1)"
  BUN_MINOR="$(echo "$BUN_VERSION" | cut -d. -f2)"

  if [[ "$BUN_MAJOR" -gt "$REQUIRED_BUN_MAJOR" ]] || \
     [[ "$BUN_MAJOR" -eq "$REQUIRED_BUN_MAJOR" && "$BUN_MINOR" -ge "$REQUIRED_BUN_MINOR" ]]; then
    pass "bun $BUN_VERSION"
  else
    warn "bun $BUN_VERSION is older than required $REQUIRED_BUN_MAJOR.$REQUIRED_BUN_MINOR"
    if confirm "Upgrade Bun?"; then
      install_bun
      pass "bun $(bun --version)"
    else
      caution "Older Bun detected — build may fail"
    fi
  fi
else
  warn "Bun not found"
  if confirm "Install Bun? (https://bun.sh)"; then
    install_bun
    pass "bun $(bun --version)"
  else
    fail "Bun is required. Install from https://bun.sh and re-run."
  fi
fi

# ── 5. Rust toolchain ─────────────────────────────────────────

step "Checking Rust toolchain"

install_rust() {
  info "Installing Rust via rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  source "$HOME/.cargo/env"
}

# Ensure cargo is in PATH even if just installed
if [[ -f "$HOME/.cargo/env" ]]; then
  source "$HOME/.cargo/env"
fi

if check_command rustc && check_command cargo; then
  RUST_VERSION="$(rustc --version | awk '{print $2}')"
  pass "rustc $RUST_VERSION"
else
  warn "Rust toolchain not found"
  if confirm "Install Rust via rustup? (https://rustup.rs)"; then
    install_rust
    if check_command rustup; then
      pass "rustc $(rustc --version | awk '{print $2}')"
    else
      fail "Rust installation failed or rustup not in PATH. Try: source \$HOME/.cargo/env"
    fi
  else
    fail "Rust is required to build the Tauri desktop shell."
  fi
fi

# Verify the platform Rust target is installed.
#
# rustup is the canonical way to manage targets, but rustc can also be
# installed via Homebrew / a system package / from source — in which case
# rustup is absent and the only target available is rustc's built-in host
# triple. That's fine for a native build (Tauri defaults to the host
# target), so detect this case and pass without asking for rustup.
step "Checking Rust target: $RUST_TARGET"

rustc_host_target() {
  rustc -vV 2>/dev/null | awk '/^host:/ {print $2}'
}

if check_command rustup; then
  if rustup target list --installed 2>/dev/null | grep -q "^$RUST_TARGET$"; then
    pass "Rust target $RUST_TARGET"
  else
    warn "Rust target $RUST_TARGET is not installed"
    if confirm "Add Rust target $RUST_TARGET?"; then
      rustup target add "$RUST_TARGET"
      pass "Rust target $RUST_TARGET"
    else
      caution "Missing Rust target — Tauri build may fail"
    fi
  fi
else
  # No rustup — rustc likely came from Homebrew or a system package.
  # Compare against rustc's native host target; if it matches, the build
  # will succeed without any target management.
  HOST_TARGET="$(rustc_host_target || true)"
  if [[ -n "$HOST_TARGET" && "$HOST_TARGET" == "$RUST_TARGET" ]]; then
    pass "Rust target $RUST_TARGET (native host, rustup not required)"
  else
    warn "rustup not found; cannot add target '$RUST_TARGET'"
    if [[ -n "$HOST_TARGET" ]]; then
      info "rustc's host target is '$HOST_TARGET', which differs from '$RUST_TARGET'."
    fi
    info "Install rustup to manage cross-compilation targets:"
    info "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
    caution "Missing rustup — Tauri build may fail if it needs '$RUST_TARGET'"
  fi
fi

# ── 6. Check port availability ───────────────────────────────

step "Checking port availability"

check_port() {
  local port="$1" name="$2"
  local in_use=false

  if check_command lsof; then
    lsof -iTCP:"$port" -sTCP:LISTEN -t &>/dev/null 2>&1 && in_use=true || true
  elif check_command ss; then
    ss -tlnp 2>/dev/null | grep -q ":$port " && in_use=true || true
  elif check_command netstat; then
    netstat -tlnp 2>/dev/null | grep -q ":$port " && in_use=true || true
  else
    info "Cannot check port $port ($name) — install lsof for port conflict detection"
    return
  fi

  if $in_use; then
    caution "Port $port ($name) is already in use — stop the existing process before running dev"
  else
    pass "Port $port ($name) is free"
  fi
}

check_port 5173 "Vite / web frontend"
check_port 45678 "Elysia API server"

# ── 7. Install project dependencies ──────────────────────────

step "Installing project dependencies"

info "Running bun install..."
bun install
pass "npm/bun dependencies"

# ── 8. Environment configuration ─────────────────────────────

step "Environment configuration (.env)"

if $SKIP_ENV; then
  info "--skip-env set, skipping .env setup"
else
  if [[ -f ".env" ]]; then
    info ".env already exists"

    # Check if the env file has empty values
    CLIENT_ID_VAL="$(grep '^GITHUB_CLIENT_ID=' .env | cut -d= -f2)"
    CLIENT_SECRET_VAL="$(grep '^GITHUB_CLIENT_SECRET=' .env | cut -d= -f2)"

    if [[ -z "$CLIENT_ID_VAL" || -z "$CLIENT_SECRET_VAL" ]]; then
      warn "GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET is empty in .env"
      if confirm "Enter GitHub OAuth credentials now?"; then
        if [[ -z "$CLIENT_ID_VAL" ]]; then
          NEW_ID="$(prompt_value "GitHub Client ID" "GITHUB_CLIENT_ID")"
          if [[ -n "$NEW_ID" ]]; then
            NEW_ID_ESC="$(printf '%s\n' "$NEW_ID" | sed 's/[\/&]/\\&/g')"
            sed -i.bak "s/^GITHUB_CLIENT_ID=.*/GITHUB_CLIENT_ID=$NEW_ID_ESC/" .env && rm -f .env.bak
          fi
        fi
        if [[ -z "$CLIENT_SECRET_VAL" ]]; then
          NEW_SECRET="$(prompt_value "GitHub Client Secret" "GITHUB_CLIENT_SECRET")"
          if [[ -n "$NEW_SECRET" ]]; then
            NEW_SECRET_ESC="$(printf '%s\n' "$NEW_SECRET" | sed 's/[\/&]/\\&/g')"
            sed -i.bak "s/^GITHUB_CLIENT_SECRET=.*/GITHUB_CLIENT_SECRET=$NEW_SECRET_ESC/" .env && rm -f .env.bak
          fi
        fi
        pass ".env credentials configured"
      else
        caution ".env missing credentials — GitHub OAuth login will not work"
        info "Create a GitHub OAuth App at: https://github.com/settings/developers"
        info "  Homepage URL:    http://localhost:5173"
        info "  Callback URL:    http://localhost:45678/api/auth/callback/github"
        info "Then add your credentials to .env"
      fi
    else
      pass ".env credentials present"
    fi
  else
    info ".env not found — creating from .env.example"
    cp .env.example .env
    success "Created .env from .env.example"

    printf "\n"
    printf "  ${BOLD}GitHub OAuth App setup${RESET}\n"
    printf "  Revv needs a GitHub OAuth App for authentication.\n"
    printf "  Create one at: ${CYAN}https://github.com/settings/developers${RESET}\n"
    printf "\n"
    printf "  Use these settings:\n"
    printf "    ${DIM}Application name:${RESET}        Revv (local dev)\n"
    printf "    ${DIM}Homepage URL:${RESET}            http://localhost:5173\n"
    printf "    ${DIM}Authorization callback URL:${RESET} http://localhost:45678/api/auth/callback/github\n"
    printf "\n"

    if confirm "Enter your GitHub OAuth credentials now?"; then
      CLIENT_ID="$(prompt_value "GitHub Client ID" "GITHUB_CLIENT_ID")"
      CLIENT_SECRET="$(prompt_value "GitHub Client Secret" "GITHUB_CLIENT_SECRET")"

      if [[ -n "$CLIENT_ID" ]]; then
        CLIENT_ID_ESC="$(printf '%s\n' "$CLIENT_ID" | sed 's/[\/&]/\\&/g')"
        sed -i.bak "s/^GITHUB_CLIENT_ID=.*/GITHUB_CLIENT_ID=$CLIENT_ID_ESC/" .env && rm -f .env.bak
      fi
      if [[ -n "$CLIENT_SECRET" ]]; then
        CLIENT_SECRET_ESC="$(printf '%s\n' "$CLIENT_SECRET" | sed 's/[\/&]/\\&/g')"
        sed -i.bak "s/^GITHUB_CLIENT_SECRET=.*/GITHUB_CLIENT_SECRET=$CLIENT_SECRET_ESC/" .env && rm -f .env.bak
      fi
      pass ".env credentials configured"
    else
      caution ".env created but credentials are empty — fill them in before running dev"
      info "Edit .env and add your GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET"
    fi
  fi
fi

# ── 9. Verify Rust/Cargo workspace ───────────────────────────

step "Verifying Cargo workspace (dry-run check)"

if [[ -f "apps/desktop/Cargo.toml" ]]; then
  info "Checking Cargo manifest (cargo metadata)..."
  if cargo metadata --manifest-path "apps/desktop/Cargo.toml" --no-deps --quiet &>/dev/null 2>&1; then
    pass "Cargo workspace is valid"
  else
    caution "Cargo metadata check failed — run 'cargo check' in apps/desktop for details"
  fi
else
  caution "apps/desktop/Cargo.toml not found — skipping Rust check"
fi

# ── 10. Summary ───────────────────────────────────────────────

printf "\n"
printf "${BOLD}${CYAN}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
printf "${BOLD}  Setup Summary${RESET}\n"
printf "${BOLD}${CYAN}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n\n"

if [[ ${#PASSED[@]} -gt 0 ]]; then
  printf "  ${GREEN}${BOLD}Passed (${#PASSED[@]})${RESET}\n"
  for item in "${PASSED[@]}"; do
    printf "    ${GREEN}✓${RESET}  %s\n" "$item"
  done
  printf "\n"
fi

if [[ ${#WARNED[@]} -gt 0 ]]; then
  printf "  ${YELLOW}${BOLD}Warnings (${#WARNED[@]})${RESET}\n"
  for item in "${WARNED[@]}"; do
    printf "    ${YELLOW}⚠${RESET}  %s\n" "$item"
  done
  printf "\n"
fi

if [[ ${#FAILED[@]} -gt 0 ]]; then
  printf "  ${RED}${BOLD}Missing (${#FAILED[@]})${RESET}\n"
  for item in "${FAILED[@]}"; do
    printf "    ${RED}✗${RESET}  %s\n" "$item"
  done
  printf "\n"
fi

if [[ ${#WARNED[@]} -eq 0 && ${#FAILED[@]} -eq 0 ]]; then
  printf "${BOLD}${GREEN}"
  printf "  ┌─────────────────────────────────────┐\n"
  printf "  │   ✓  Everything looks good!         │\n"
  printf "  └─────────────────────────────────────┘\n"
  printf "${RESET}\n"
else
  printf "${BOLD}${YELLOW}"
  printf "  ┌─────────────────────────────────────┐\n"
  printf "  │   ⚠  Setup complete with warnings   │\n"
  printf "  └─────────────────────────────────────┘\n"
  printf "${RESET}\n"
  info "Address warnings above before running dev for best results."
fi

printf "\n"
printf "  ${BOLD}Start developing:${RESET}\n"
printf "    ${DIM}\$${RESET} bun run dev:desktop   ${DIM}# Tauri desktop + web + server${RESET}\n"
printf "    ${DIM}\$${RESET} bun run dev           ${DIM}# All services via Turborepo${RESET}\n"
printf "    ${DIM}\$${RESET} bun run dev:web       ${DIM}# Web frontend only (port 5173)${RESET}\n"
printf "    ${DIM}\$${RESET} bun run dev:server    ${DIM}# API server only (port 45678)${RESET}\n"
printf "\n"
printf "  ${BOLD}Other useful commands:${RESET}\n"
printf "    ${DIM}\$${RESET} make typecheck        ${DIM}# TypeScript type checking${RESET}\n"
printf "    ${DIM}\$${RESET} make dist             ${DIM}# Build .dmg / .deb / .msi installer${RESET}\n"
printf "    ${DIM}\$${RESET} make reset-db         ${DIM}# Delete local SQLite database${RESET}\n"
printf "\n"
