#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────
# Rev — Developer Environment Installer
# Sets up everything needed to develop and build Rev from source.
# Usage:  ./install.sh          (interactive, prompts before installs)
#         ./install.sh --yes    (non-interactive, auto-approve)
# ──────────────────────────────────────────────────────────────

REQUIRED_BUN_MAJOR=1
REQUIRED_BUN_MINOR=3
AUTO_YES=false

# ── Colors & helpers ──────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

info()    { printf "${BLUE}[info]${RESET}  %s\n" "$*"; }
success() { printf "${GREEN}[  ok]${RESET}  %s\n" "$*"; }
warn()    { printf "${YELLOW}[warn]${RESET}  %s\n" "$*"; }
fail()    { printf "${RED}[fail]${RESET}  %s\n" "$*"; exit 1; }
step()    { printf "\n${BOLD}${CYAN}▸ %s${RESET}\n" "$*"; }

confirm() {
  if $AUTO_YES; then return 0; fi
  printf "${YELLOW}  → %s [Y/n] ${RESET}" "$1"
  read -r reply
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

# ── Parse args ────────────────────────────────────────────────

for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO_YES=true ;;
    --help|-h)
      echo "Usage: ./install.sh [--yes|-y] [--help|-h]"
      echo "  --yes, -y   Non-interactive mode (auto-approve all installs)"
      echo "  --help, -h  Show this help message"
      exit 0
      ;;
  esac
done

# ── Header ────────────────────────────────────────────────────

printf "\n${BOLD}"
printf "  ┌─────────────────────────────────────┐\n"
printf "  │       Rev — Development Setup        │\n"
printf "  │       AI-Powered Code Review         │\n"
printf "  └─────────────────────────────────────┘\n"
printf "${RESET}\n"

# ── Detect platform ───────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"
info "Platform: $OS $ARCH"

case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *)      fail "Unsupported operating system: $OS. Use install.ps1 for Windows." ;;
esac

# ── 1. System dependencies ───────────────────────────────────

step "Checking system dependencies"

check_command() {
  command -v "$1" &>/dev/null
}

# Git
if check_command git; then
  success "git $(git --version | awk '{print $3}')"
else
  fail "git is not installed. Please install git first: https://git-scm.com"
fi

# Platform-specific build tools
if [[ "$PLATFORM" == "macos" ]]; then
  if xcode-select -p &>/dev/null; then
    success "Xcode Command Line Tools installed"
  else
    warn "Xcode Command Line Tools not found"
    if confirm "Install Xcode Command Line Tools?"; then
      xcode-select --install
      info "Waiting for Xcode CLT installation to complete..."
      info "Please complete the installation dialog, then re-run this script."
      exit 0
    else
      fail "Xcode Command Line Tools are required for building Tauri on macOS"
    fi
  fi
elif [[ "$PLATFORM" == "linux" ]]; then
  MISSING_PKGS=()

  # Check for essential Tauri Linux dependencies
  for cmd in pkg-config; do
    if ! check_command "$cmd"; then
      MISSING_PKGS+=("$cmd")
    fi
  done

  # Check for libraries via pkg-config
  for lib in webkit2gtk-4.1 gtk+-3.0 libssl openssl; do
    if ! pkg-config --exists "$lib" 2>/dev/null; then
      MISSING_PKGS+=("$lib")
    fi
  done

  if [[ ${#MISSING_PKGS[@]} -gt 0 ]]; then
    warn "Missing system packages: ${MISSING_PKGS[*]}"
    info "On Ubuntu/Debian, install with:"
    echo "  sudo apt update && sudo apt install -y \\"
    echo "    build-essential curl wget file \\"
    echo "    libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev \\"
    echo "    librsvg2-dev patchelf libayatana-appindicator3-dev"
    echo ""
    info "On Fedora:"
    echo "  sudo dnf install -y \\"
    echo "    openssl-devel gtk3-devel webkit2gtk4.1-devel \\"
    echo "    librsvg2-devel patchelf libappindicator-gtk3-devel"
    echo ""

    if [[ "$PLATFORM" == "linux" ]] && check_command apt; then
      if confirm "Install missing packages via apt?"; then
        sudo apt update
        sudo apt install -y \
          build-essential curl wget file \
          libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev \
          librsvg2-dev patchelf libayatana-appindicator3-dev
        success "System packages installed"
      else
        warn "Skipping — build may fail without these packages"
      fi
    fi
  else
    success "Linux system dependencies look good"
  fi
fi

# ── 2. Bun ────────────────────────────────────────────────────

step "Checking Bun runtime"

install_bun() {
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  # Source the new PATH
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
}

if check_command bun; then
  BUN_VERSION="$(bun --version)"
  BUN_MAJOR="$(echo "$BUN_VERSION" | cut -d. -f1)"
  BUN_MINOR="$(echo "$BUN_VERSION" | cut -d. -f2)"

  if [[ "$BUN_MAJOR" -gt "$REQUIRED_BUN_MAJOR" ]] || \
     [[ "$BUN_MAJOR" -eq "$REQUIRED_BUN_MAJOR" && "$BUN_MINOR" -ge "$REQUIRED_BUN_MINOR" ]]; then
    success "bun $BUN_VERSION (>= $REQUIRED_BUN_MAJOR.$REQUIRED_BUN_MINOR required)"
  else
    warn "bun $BUN_VERSION found but >= $REQUIRED_BUN_MAJOR.$REQUIRED_BUN_MINOR is required"
    if confirm "Upgrade Bun?"; then
      install_bun
      success "bun $(bun --version)"
    else
      warn "Continuing with older Bun — build may fail"
    fi
  fi
else
  warn "Bun is not installed"
  if confirm "Install Bun? (https://bun.sh)"; then
    install_bun
    success "bun $(bun --version)"
  else
    fail "Bun is required to build Rev"
  fi
fi

# ── 3. Rust toolchain ────────────────────────────────────────

step "Checking Rust toolchain"

install_rust() {
  info "Installing Rust via rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
}

if check_command rustc && check_command cargo; then
  RUST_VERSION="$(rustc --version | awk '{print $2}')"
  success "rustc $RUST_VERSION"
  success "cargo $(cargo --version | awk '{print $2}')"
else
  warn "Rust toolchain not found"
  if confirm "Install Rust via rustup? (https://rustup.rs)"; then
    install_rust
    success "rustc $(rustc --version | awk '{print $2}')"
  else
    fail "Rust is required to build the Tauri desktop shell"
  fi
fi

# ── 4. Tauri CLI ──────────────────────────────────────────────

step "Checking Tauri CLI"

# Tauri CLI is a dev dependency, but we verify it's accessible
if bun pm ls 2>/dev/null | grep -q "@tauri-apps/cli" 2>/dev/null; then
  success "@tauri-apps/cli found in dependencies"
else
  info "@tauri-apps/cli will be installed with dependencies"
fi

# ── 5. Install project dependencies ──────────────────────────

step "Installing project dependencies"

cd "$(dirname "$0")"
PROJECT_ROOT="$(pwd)"
info "Project root: $PROJECT_ROOT"

info "Running bun install..."
bun install
success "All npm dependencies installed"

# ── 6. Verify workspace packages ─────────────────────────────

step "Verifying workspace structure"

for dir in apps/web apps/server apps/desktop packages/shared; do
  if [[ -d "$dir" ]]; then
    success "$dir"
  else
    fail "Missing workspace directory: $dir"
  fi
done

# ── 7. Build shared package ──────────────────────────────────

step "Building shared package"

info "Type-checking @rev/shared..."
cd "$PROJECT_ROOT/packages/shared"
if bun run typecheck 2>/dev/null; then
  success "@rev/shared types verified"
else
  warn "@rev/shared typecheck had issues (may be fine for dev)"
fi
cd "$PROJECT_ROOT"

# ── 8. Initialize database ───────────────────────────────────

step "Initializing database"

if [[ -f "apps/server/rev.db" ]]; then
  info "Database already exists at apps/server/rev.db"
  success "Database ready"
else
  info "Database will be created on first server start"
  success "Database setup deferred to first run"
fi

# ── 9. Verify builds ─────────────────────────────────────────

step "Verifying build system"

info "Running typecheck across all packages..."
if bun run typecheck 2>/dev/null; then
  success "All packages pass typecheck"
else
  warn "Typecheck had issues — this is expected during initial development"
fi

# ── 10. Summary ───────────────────────────────────────────────

printf "\n"
printf "${BOLD}${GREEN}"
printf "  ┌─────────────────────────────────────┐\n"
printf "  │         Setup Complete!              │\n"
printf "  └─────────────────────────────────────┘\n"
printf "${RESET}\n"

printf "  ${BOLD}Quick start:${RESET}\n"
printf "    ${DIM}$${RESET} bun run dev           ${DIM}# Start all services in dev mode${RESET}\n"
printf "    ${DIM}$${RESET} bun run dev:web       ${DIM}# Start just the frontend${RESET}\n"
printf "    ${DIM}$${RESET} bun run dev:server    ${DIM}# Start just the backend${RESET}\n"
printf "    ${DIM}$${RESET} bun run dev:desktop   ${DIM}# Start the Tauri desktop app${RESET}\n"
printf "\n"
printf "  ${BOLD}Build for distribution:${RESET}\n"
printf "    ${DIM}$${RESET} make dist             ${DIM}# Build platform installer (.dmg/.msi/.deb)${RESET}\n"
printf "    ${DIM}$${RESET} bun run build         ${DIM}# Build all packages (no installer)${RESET}\n"
printf "\n"
printf "  ${BOLD}Architecture:${RESET}\n"
printf "    ${DIM}Web UI${RESET}    → http://localhost:5173  ${DIM}(SvelteKit + Tailwind)${RESET}\n"
printf "    ${DIM}API${RESET}       → http://localhost:45678 ${DIM}(Elysia + SQLite)${RESET}\n"
printf "    ${DIM}Desktop${RESET}   → Tauri v2 native window\n"
printf "\n"
