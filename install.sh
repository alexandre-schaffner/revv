#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Revv — Unified Installer
#
# One script, two audiences:
#
#   Curl-piped (end user):
#     curl -fsSL https://raw.githubusercontent.com/alexandre-schaffner/revv/main/install.sh | bash
#
#   From a checkout (developer):
#     ./install.sh --dev       # toolchain + bun install, stop there
#     ./install.sh             # full install (build .app, LaunchAgent, CLI)
#
# Flags:
#   --dev            Install the dev toolchain and project deps, nothing more.
#                    Use this before running `make dev`.
#   --yes, -y        Non-interactive: auto-approve every prompt.
#   --help, -h       This message.
#
# Environment overrides:
#   REVV_REPO_URL         Git URL (default: https://github.com/alexandre-schaffner/revv.git)
#   REVV_BRANCH           Branch to clone (default: main)
#   REVV_INSTALL_DIR      Source install dir (default: ~/Library/Application Support/Revv/src)
#   REVV_APP_DIR          App install dir  (default: /Applications, falls back to ~/Applications)
#   REVV_AUTO_YES=1       Same as --yes
#
# Notes:
#   • End-user install currently targets macOS only. --dev works on macOS and
#     Linux (toolchain install + deps).
#   • No .env prompts. Revv's GitHub OAuth App is bundled; secrets are
#     generated locally and never leave the machine.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────
REVV_REPO_URL="${REVV_REPO_URL:-https://github.com/alexandre-schaffner/revv.git}"
REVV_BRANCH="${REVV_BRANCH:-main}"
REVV_APP_DIR="${REVV_APP_DIR:-/Applications}"
REVV_AUTO_YES="${REVV_AUTO_YES:-0}"
MODE="user"   # user | dev

# ── Parse args ───────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --dev)       MODE="dev" ;;
    --yes|-y)    REVV_AUTO_YES=1 ;;
    --help|-h)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf '[FAIL]  Unknown argument: %s\n\n' "$arg" >&2
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//' >&2
      exit 2
      ;;
  esac
done
export REVV_AUTO_YES

# ── Inline bootstrap helpers ──────────────────────────────────
# We can't source scripts/lib/common.sh yet — we might be running from a
# curl-pipe where the file isn't on disk. Define just enough to clone the
# repo, then re-exec under the on-disk installer which *can* source the lib.
if [[ -t 1 ]]; then
  _RED=$'\033[0;31m'; _GREEN=$'\033[0;32m'; _YELLOW=$'\033[1;33m'
  _BLUE=$'\033[0;34m'; _CYAN=$'\033[0;36m'; _BOLD=$'\033[1m'; _RESET=$'\033[0m'
else
  _RED="" _GREEN="" _YELLOW="" _BLUE="" _CYAN="" _BOLD="" _RESET=""
fi
_info()    { printf '%s[info]%s  %s\n' "$_BLUE"   "$_RESET" "$*"; }
_success() { printf '%s[  ok]%s  %s\n' "$_GREEN"  "$_RESET" "$*"; }
_warn()    { printf '%s[warn]%s  %s\n' "$_YELLOW" "$_RESET" "$*"; }
_fail()    { printf '%s[FAIL]%s  %s\n' "$_RED"    "$_RESET" "$*" >&2; exit 1; }
_step()    { printf '\n%s%s▸ %s%s\n'  "$_BOLD" "$_CYAN" "$*" "$_RESET"; }

_check_cmd() { command -v "$1" >/dev/null 2>&1; }

# ── Header ────────────────────────────────────────────────────
printf '\n%s' "$_BOLD"
if [[ "$MODE" == "dev" ]]; then
  printf '  ┌─────────────────────────────────────┐\n'
  printf '  │       Revv — Developer Setup        │\n'
  printf '  └─────────────────────────────────────┘\n'
else
  printf '  ┌─────────────────────────────────────┐\n'
  printf '  │          Revv — Installer           │\n'
  printf '  │       AI-Powered Code Review        │\n'
  printf '  └─────────────────────────────────────┘\n'
fi
printf '%s\n' "$_RESET"

# ── Locate the checkout, cloning if necessary ─────────────────
#
# Three scenarios:
#
#  (a) We're piped from curl. BASH_SOURCE[0] is empty/non-existent and this
#      script has no neighbours on disk. Clone the repo, then re-exec the
#      on-disk copy so the rest of the flow has everything it needs.
#
#  (b) We're run from inside a checkout (./install.sh). BASH_SOURCE[0] is
#      a real file sitting next to package.json. Nothing to clone.
#
#  (c) We already re-exec'd ourselves from (a). Same as (b) but arrived
#      via exec, not by the user's hand.

PROJECT_ROOT=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  if [[ -f "$script_dir/package.json" ]] \
     && grep -q '"name": "revv"' "$script_dir/package.json" 2>/dev/null; then
    PROJECT_ROOT="$script_dir"
  fi
fi

if [[ -z "$PROJECT_ROOT" ]]; then
  # Curl-pipe path. For now we only support macOS bootstrap — Linux users
  # should `git clone` manually and then run `./install.sh --dev`.
  _step "Bootstrapping from curl"
  os="$(uname -s)"
  if [[ "$os" != "Darwin" ]]; then
    _fail "Curl-piped install currently targets macOS only.
On $os, clone the repo and run ./install.sh --dev manually:
  git clone $REVV_REPO_URL
  cd revv && ./install.sh --dev"
  fi

  # Xcode CLT (gives us git). Minimal inline copy of ensure_xcode_clt —
  # we don't have the helper lib on disk yet.
  if ! xcode-select -p >/dev/null 2>&1; then
    _warn "Xcode Command Line Tools are required."
    xcode-select --install >/dev/null 2>&1 || true
    _info "A system dialog has opened. Click Install, accept the license, and wait for it to finish."
    _info "Press Enter here once the installation completes…"
    read -r _ </dev/tty || true
    xcode-select -p >/dev/null 2>&1 \
      || _fail "Xcode CLT still missing. Install manually and re-run."
  fi
  _check_cmd git || _fail "git not found after Xcode CLT install."

  dest="${REVV_INSTALL_DIR:-$HOME/Library/Application Support/Revv/src}"
  mkdir -p "$(dirname "$dest")"
  if [[ -d "$dest/.git" ]]; then
    _info "Existing clone at $dest — updating"
    git -C "$dest" fetch --all --prune
    git -C "$dest" checkout "$REVV_BRANCH"
    git -C "$dest" reset --hard "origin/$REVV_BRANCH"
  elif [[ -e "$dest" ]]; then
    _fail "$dest exists but is not a git clone. Move it aside and re-run."
  else
    _info "Cloning $REVV_REPO_URL ($REVV_BRANCH) → $dest"
    git clone --branch "$REVV_BRANCH" --depth 50 "$REVV_REPO_URL" "$dest"
  fi

  _info "Re-executing installer from the cloned checkout"
  # Preserve flags for the re-exec — quote heavily, path may contain spaces.
  exec bash "$dest/install.sh" "$@"
fi

# ── Source the shared helper library ──────────────────────────
if [[ ! -f "$PROJECT_ROOT/scripts/lib/common.sh" ]]; then
  _fail "$PROJECT_ROOT/scripts/lib/common.sh is missing. Your checkout is incomplete."
fi
# shellcheck disable=SC1091
source "$PROJECT_ROOT/scripts/lib/common.sh"

info "Project root: $PROJECT_ROOT"

# ── 1. Platform detect ────────────────────────────────────────
step "Detecting platform"
detect_platform
success "Platform: $PLATFORM ($ARCH) → target $RUST_TARGET"

if [[ "$MODE" == "user" && "$PLATFORM" != "macos" ]]; then
  fail "End-user install currently supports macOS only. On Linux, run:
  ./install.sh --dev"
fi

# ── 2. Toolchain ──────────────────────────────────────────────
step "Checking build toolchain"
ensure_xcode_clt
ensure_git
ensure_bun
ensure_rust

# Pick up bun/cargo in this shell if they were just installed.
[[ -d "$HOME/.bun/bin" ]] && export PATH="$HOME/.bun/bin:$PATH"
# shellcheck disable=SC1091
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"

# ── 3. Linux system libs (dev mode) ───────────────────────────
if [[ "$PLATFORM" == "linux" ]]; then
  step "Checking Linux system libraries"
  missing=()
  check_cmd pkg-config || missing+=("pkg-config")
  if check_cmd pkg-config; then
    for lib in webkit2gtk-4.1 gtk+-3.0 openssl; do
      pkg-config --exists "$lib" 2>/dev/null || missing+=("$lib")
    done
  fi
  if [[ ${#missing[@]} -eq 0 ]]; then
    success "Tauri system libraries present"
  else
    warn "Missing system packages: ${missing[*]}"
    cat <<'EOT'
  On Ubuntu/Debian:
    sudo apt update && sudo apt install -y \
      build-essential curl wget file \
      libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev \
      librsvg2-dev patchelf libayatana-appindicator3-dev
EOT
    warn "Install those first, then re-run this script."
  fi
fi

# ── 4. Install project deps ───────────────────────────────────
step "Installing project dependencies"
cd "$PROJECT_ROOT"
info "Running bun install…"
bun install
success "Workspace dependencies installed"

# ── 5. Dev mode exits here ────────────────────────────────────
if [[ "$MODE" == "dev" ]]; then
  printf '\n%s%s' "$REVV_BOLD" "$REVV_GREEN"
  printf '  ┌─────────────────────────────────────┐\n'
  printf '  │   ✓  Dev environment ready          │\n'
  printf '  └─────────────────────────────────────┘\n'
  printf '%s\n' "$REVV_RESET"
  printf '  %sStart developing:%s\n' "$REVV_BOLD" "$REVV_RESET"
  printf '    %s$%s make dev             %s# all services (web, server, Tauri)%s\n' "$REVV_DIM" "$REVV_RESET" "$REVV_DIM" "$REVV_RESET"
  printf '    %s$%s make dev-server      %s# API only (port 45678)%s\n' "$REVV_DIM" "$REVV_RESET" "$REVV_DIM" "$REVV_RESET"
  printf '    %s$%s make dev-web         %s# frontend only (port 5173)%s\n\n' "$REVV_DIM" "$REVV_RESET" "$REVV_DIM" "$REVV_RESET"
  printf '  On first server start, Revv generates an auth key at:\n'
  printf '    %s\n' "${REVV_AUTH_KEY:-$HOME/Library/Application Support/Revv/auth.key}"
  printf '  No .env file is required for normal use — see .env.example for\n'
  printf '  optional overrides (custom GitHub client_id, DB path, etc.).\n\n'
  exit 0
fi

# ── 6. User install: auth key, build, ship ────────────────────

step "Ensuring auth key"
ensure_auth_key

step "Building Revv.app (first run can take several minutes)"
# We build only the .app, not the .dmg. The .dmg flow (create-dmg) is
# fragile with paths containing spaces or parentheses and we copy the
# .app to /Applications directly anyway.
(
  cd "$PROJECT_ROOT/packages/shared" && bun run typecheck
)
(
  cd "$PROJECT_ROOT" && bun run build
)
(
  cd "$PROJECT_ROOT/apps/desktop" && bunx tauri build --bundles app
)

bundle_macos_dir="$PROJECT_ROOT/apps/desktop/target/release/bundle/macos"
bundle_app="$(find "$bundle_macos_dir" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -1)"
if [[ -z "$bundle_app" ]]; then
  bundle_app="$(find "$PROJECT_ROOT/apps/desktop/target" -maxdepth 6 -type d -name '*.app' -path '*/bundle/macos/*' 2>/dev/null | head -1)"
fi
[[ -n "$bundle_app" && -d "$bundle_app" ]] \
  || fail "Build finished but no .app was found under $bundle_macos_dir"
app_name="$(basename "$bundle_app")"
app_process_name="${app_name%.app}"
success "Built $bundle_app"

step "Installing $app_name"
# Prefer /Applications; fall back to ~/Applications if unwritable.
if [[ -w "$REVV_APP_DIR" ]]; then
  dest_app_dir="$REVV_APP_DIR"
else
  warn "$REVV_APP_DIR is not writable — using ~/Applications"
  dest_app_dir="$HOME/Applications"
  mkdir -p "$dest_app_dir"
fi
dest_app="$dest_app_dir/$app_name"

# Clear quarantine before copying; it may still land on the destination
# but be robust and strip again after the copy.
xattr -cr "$bundle_app" 2>/dev/null || true

# Stop any running instance and unload the agent so we can swap the binary.
if [[ -f "$REVV_LAUNCH_AGENT_PLIST" ]]; then
  launchctl unload "$REVV_LAUNCH_AGENT_PLIST" 2>/dev/null || true
fi
osascript -e "tell application \"$app_process_name\" to quit" 2>/dev/null || true
sleep 1

[[ -d "$dest_app" ]] && rm -rf "$dest_app"
cp -R "$bundle_app" "$dest_app"
xattr -cr "$dest_app" 2>/dev/null || true
success "Installed → $dest_app"

# ── 7. LaunchAgent ────────────────────────────────────────────
step "Installing background service (LaunchAgent)"
mkdir -p "$(dirname "$REVV_LAUNCH_AGENT_PLIST")" "$REVV_LOG_DIR"
bun_bin="$HOME/.bun/bin/bun"
[[ -x "$bun_bin" ]] || bun_bin="$(command -v bun || true)"
[[ -x "$bun_bin" ]] || fail "Cannot locate bun executable for the LaunchAgent."
server_entry="$PROJECT_ROOT/apps/server/src/index.ts"
[[ -f "$server_entry" ]] || fail "Server entry point missing: $server_entry"

cat > "$REVV_LAUNCH_AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.revv.server</string>

    <key>ProgramArguments</key>
    <array>
        <string>$bun_bin</string>
        <string>run</string>
        <string>apps/server/src/index.ts</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_ROOT</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$HOME/.bun/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>$REVV_LOG_DIR/server.out.log</string>

    <key>StandardErrorPath</key>
    <string>$REVV_LOG_DIR/server.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$REVV_LAUNCH_AGENT_PLIST" 2>/dev/null || true
launchctl load -w "$REVV_LAUNCH_AGENT_PLIST"
success "LaunchAgent loaded (com.revv.server)"

info "Waiting for API server on http://localhost:45678 …"
for i in {1..30}; do
  if curl -fsS --max-time 1 "http://localhost:45678/api/health" >/dev/null 2>&1 \
     || curl -fsS --max-time 1 "http://localhost:45678/" >/dev/null 2>&1 \
     || nc -z 127.0.0.1 45678 >/dev/null 2>&1; then
    success "Server is listening"
    break
  fi
  sleep 1
  if [[ $i -eq 30 ]]; then
    warn "Server didn't respond within 30s. Check logs: tail -f '$REVV_LOG_DIR/server.err.log'"
  fi
done

# ── 8. Install the management CLI ─────────────────────────────
step "Installing revv CLI"
mkdir -p "$REVV_SUPPORT_DIR"
cat > "$REVV_SUPPORT_DIR/config" <<CFG
# Managed by install.sh. The revv CLI reads these values so that subsequent
# 'revv update' / 'revv status' calls find the right paths even when the
# installer was run from a non-default location.
SOURCE_DIR="$PROJECT_ROOT"
APP_PATH="$dest_app"
INSTALLED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
CFG
success "Wrote $REVV_SUPPORT_DIR/config"

mkdir -p "$REVV_CLI_DIR" "$REVV_CLI_DIR/../share/revv"
cp "$PROJECT_ROOT/scripts/revv" "$REVV_CLI_DIR/revv"
chmod +x "$REVV_CLI_DIR/revv"
# Ship the shared helper lib alongside the CLI so it keeps working even
# after the source tree moves. The CLI looks for it at $REVV_CLI_LIB.
cp "$PROJECT_ROOT/scripts/lib/common.sh" "$REVV_CLI_DIR/../share/revv/common.sh"
success "Installed → $REVV_CLI_DIR/revv"

if ! printf '%s' ":$PATH:" | grep -q ":$REVV_CLI_DIR:"; then
  shell_rc=""
  case "${SHELL##*/}" in
    zsh)  shell_rc="$HOME/.zshrc" ;;
    bash) shell_rc="$HOME/.bashrc" ;;
  esac
  if [[ -n "$shell_rc" ]] && ! grep -qs "\\.local/bin" "$shell_rc" 2>/dev/null; then
    if confirm "Add $REVV_CLI_DIR to your PATH in $shell_rc?"; then
      {
        printf '\n# Added by Revv installer\n'
        printf 'export PATH="%s:$PATH"\n' "$REVV_CLI_DIR"
      } >> "$shell_rc"
      success "Updated $shell_rc — open a new terminal for it to take effect."
    fi
  else
    warn "$REVV_CLI_DIR is not on your PATH. Add this to your shell rc:"
    printf '    export PATH="%s:$PATH"\n' "$REVV_CLI_DIR"
  fi
fi

# ── 9. Launch the app ─────────────────────────────────────────
step "Launching Revv"
open "$dest_app" || warn "Could not auto-launch. Open it from $dest_app_dir manually."

# ── 10. Summary ───────────────────────────────────────────────
printf '\n%s%s' "$REVV_BOLD" "$REVV_GREEN"
printf '  ┌────────────────────────────────────────┐\n'
printf '  │   ✓  Revv installed successfully       │\n'
printf '  └────────────────────────────────────────┘\n'
printf '%s\n' "$REVV_RESET"

printf '  %sApp:%s        %s\n'    "$REVV_BOLD" "$REVV_RESET" "$dest_app"
printf '  %sSource:%s     %s\n'    "$REVV_BOLD" "$REVV_RESET" "$PROJECT_ROOT"
printf '  %sServer:%s     com.revv.server (http://localhost:45678)\n' "$REVV_BOLD" "$REVV_RESET"
printf '  %sAuth key:%s   %s\n'    "$REVV_BOLD" "$REVV_RESET" "$REVV_AUTH_KEY"
printf '  %sLogs:%s       %s\n'    "$REVV_BOLD" "$REVV_RESET" "$REVV_LOG_DIR"
printf '\n  %sManage with the revv CLI:%s\n' "$REVV_BOLD" "$REVV_RESET"
printf '    %s$%s revv status      show app + server status\n'    "$REVV_DIM" "$REVV_RESET"
printf '    %s$%s revv update      pull latest, rebuild, reinstall\n' "$REVV_DIM" "$REVV_RESET"
printf '    %s$%s revv restart     restart the API server\n'      "$REVV_DIM" "$REVV_RESET"
printf '    %s$%s revv logs        tail server logs\n'            "$REVV_DIM" "$REVV_RESET"
printf '    %s$%s revv uninstall   remove everything\n\n'         "$REVV_DIM" "$REVV_RESET"
