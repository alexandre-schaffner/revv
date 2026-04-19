#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Revv — One-Command macOS Installer
#
# Installs Revv from source on macOS:
#   1. Installs build prerequisites (Xcode CLT, Bun, Rust) if missing
#   2. Clones the repository to ~/Library/Application Support/Revv/src
#   3. Builds the .app with `make dist`
#   4. Copies Revv.app to /Applications
#   5. Installs a LaunchAgent so the API server runs in the background
#   6. Installs a `revv` CLI to ~/.local/bin for update/uninstall/status
#
# Usage (curl-pipe):
#   curl -fsSL https://raw.githubusercontent.com/alexandre-schaffner/revv/main/scripts/install-macos.sh | bash
#
# Usage (local):
#   ./scripts/install-macos.sh
#
# Env overrides:
#   REVV_REPO_URL          Git URL (default: https://github.com/alexandre-schaffner/revv.git)
#   REVV_BRANCH            Branch (default: main)
#   REVV_INSTALL_DIR       Source install dir (default: ~/Library/Application Support/Revv/src)
#   REVV_APP_DIR           App install dir (default: /Applications)
#   REVV_GITHUB_CLIENT_ID  Skip interactive OAuth prompt
#   REVV_GITHUB_CLIENT_SECRET
#   REVV_NONINTERACTIVE=1  Never prompt; fail if input is required
# ──────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config ───────────────────────────────────────────────────
REPO_URL="${REVV_REPO_URL:-https://github.com/alexandre-schaffner/revv.git}"
BRANCH="${REVV_BRANCH:-main}"
INSTALL_DIR="${REVV_INSTALL_DIR:-$HOME/Library/Application Support/Revv/src}"
APP_DIR="${REVV_APP_DIR:-/Applications}"
CLI_DIR="$HOME/.local/bin"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LAUNCH_AGENT_LABEL="com.revv.server"
LAUNCH_AGENT_PLIST="$LAUNCH_AGENT_DIR/$LAUNCH_AGENT_LABEL.plist"
LOG_DIR="$HOME/Library/Logs/Revv"
NONINTERACTIVE="${REVV_NONINTERACTIVE:-0}"

# ── Colors ───────────────────────────────────────────────────
if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
  BLUE=$'\033[0;34m'; CYAN=$'\033[0;36m'; BOLD=$'\033[1m'
  DIM=$'\033[2m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""; BOLD=""; DIM=""; RESET=""
fi

info()    { printf "%s[info]%s  %s\n" "$BLUE" "$RESET" "$*"; }
success() { printf "%s[  ok]%s  %s\n" "$GREEN" "$RESET" "$*"; }
warn()    { printf "%s[warn]%s  %s\n" "$YELLOW" "$RESET" "$*"; }
fail()    { printf "%s[FAIL]%s  %s\n" "$RED" "$RESET" "$*" >&2; exit 1; }
step()    { printf "\n%s%s▸ %s%s\n" "$BOLD" "$CYAN" "$*" "$RESET"; }

# Read from /dev/tty so prompts work even under `curl | bash`
read_tty() {
  local __varname="$1" __prompt="$2" __default="${3:-}" __silent="${4:-}"
  if [[ "$NONINTERACTIVE" == "1" ]]; then
    if [[ -n "$__default" ]]; then
      printf -v "$__varname" '%s' "$__default"
      return 0
    fi
    fail "Cannot prompt for '$__prompt' in non-interactive mode"
  fi
  printf "%s  → %s%s%s " "$YELLOW" "$__prompt" \
    "$([[ -n "$__default" ]] && printf ' [%s]' "$__default")" "$RESET"
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
  if [[ "$NONINTERACTIVE" == "1" ]]; then return 0; fi
  local reply
  read_tty reply "$1 [Y/n]" "Y"
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

check_cmd() { command -v "$1" >/dev/null 2>&1; }

# ── Banner ───────────────────────────────────────────────────
printf "\n%s" "$BOLD"
printf "  ┌────────────────────────────────────────┐\n"
printf "  │   Revv — One-Command macOS Installer   │\n"
printf "  └────────────────────────────────────────┘\n"
printf "%s\n" "$RESET"

# ── 1. Sanity checks ─────────────────────────────────────────
step "Verifying macOS"
[[ "$(uname -s)" == "Darwin" ]] || fail "This installer targets macOS only."
success "macOS $(sw_vers -productVersion) on $(uname -m)"

# ── 2. Xcode CLT (needed for git, cargo, codesign) ──────────
step "Checking Xcode Command Line Tools"
if xcode-select -p >/dev/null 2>&1; then
  success "Xcode CLT present at $(xcode-select -p)"
else
  warn "Xcode Command Line Tools are required."
  if confirm "Trigger the Apple installer dialog now?"; then
    xcode-select --install >/dev/null 2>&1 || true
    info "A system dialog has opened. Click Install, accept the license, and wait for it to complete."
    info "Press Enter here once the installation finishes…"
    read -r _ </dev/tty
    xcode-select -p >/dev/null 2>&1 || fail "Xcode CLT still missing. Install manually and re-run."
    success "Xcode CLT installed"
  else
    fail "Xcode CLT is required. Install with: xcode-select --install"
  fi
fi

# ── 3. Git (should come from Xcode CLT, but double-check) ───
step "Checking git"
check_cmd git || fail "git not found. It should ship with Xcode CLT — re-run 'xcode-select --install'."
success "git $(git --version | awk '{print $3}')"

# ── 4. Clone or update source tree ───────────────────────────
step "Preparing source tree"
mkdir -p "$(dirname "$INSTALL_DIR")"

# If we're running from inside a Revv checkout (useful for local testing
# before the installer is pushed to origin), use that instead of cloning.
# Only activate this when BASH_SOURCE points to a real file on disk — when
# invoked via `curl | bash` the source is stdin and we must clone.
LOCAL_REPO=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  if [[ -f "$SCRIPT_DIR/../package.json" ]] \
     && grep -q '"name": "revv"' "$SCRIPT_DIR/../package.json" 2>/dev/null; then
    LOCAL_REPO="$(cd "$SCRIPT_DIR/.." && pwd -P)"
  fi
fi

if [[ -n "$LOCAL_REPO" ]]; then
  info "Running from a local checkout at $LOCAL_REPO — skipping clone"
  INSTALL_DIR="$LOCAL_REPO"
elif [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Existing clone found at $INSTALL_DIR — updating"
  git -C "$INSTALL_DIR" fetch --all --prune
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
  success "Updated to $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
else
  if [[ -e "$INSTALL_DIR" ]]; then
    fail "$INSTALL_DIR exists but is not a git clone. Move it aside and re-run."
  fi
  info "Cloning $REPO_URL ($BRANCH) into $INSTALL_DIR"
  git clone --branch "$BRANCH" --depth 50 "$REPO_URL" "$INSTALL_DIR"
  success "Cloned at $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
fi

cd "$INSTALL_DIR"

# ── 5. Collect env values BEFORE running the dev installer ──
step "Configuring environment (.env)"

# Load existing values if any, so updates keep prior credentials.
EXISTING_CLIENT_ID=""
EXISTING_CLIENT_SECRET=""
EXISTING_AUTH_SECRET=""
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  EXISTING_CLIENT_ID="$(grep -E '^GITHUB_CLIENT_ID=' .env | head -1 | cut -d= -f2- || true)"
  EXISTING_CLIENT_SECRET="$(grep -E '^GITHUB_CLIENT_SECRET=' .env | head -1 | cut -d= -f2- || true)"
  EXISTING_AUTH_SECRET="$(grep -E '^BETTER_AUTH_SECRET=' .env | head -1 | cut -d= -f2- || true)"
fi

CLIENT_ID="${REVV_GITHUB_CLIENT_ID:-$EXISTING_CLIENT_ID}"
CLIENT_SECRET="${REVV_GITHUB_CLIENT_SECRET:-$EXISTING_CLIENT_SECRET}"
AUTH_SECRET="$EXISTING_AUTH_SECRET"

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  printf "\n  %sGitHub OAuth App setup%s\n" "$BOLD" "$RESET"
  printf "  Revv signs in with GitHub. Create an OAuth App at:\n"
  printf "    %shttps://github.com/settings/developers%s\n" "$CYAN" "$RESET"
  printf "  Use these settings:\n"
  printf "    %sHomepage URL:%s               http://localhost:5173\n" "$DIM" "$RESET"
  printf "    %sAuthorization callback URL:%s http://localhost:45678/api/auth/callback/github\n\n" "$DIM" "$RESET"
  [[ -z "$CLIENT_ID" ]]     && read_tty CLIENT_ID     "GitHub Client ID"
  [[ -z "$CLIENT_SECRET" ]] && read_tty CLIENT_SECRET "GitHub Client Secret" "" "silent"
fi

[[ -n "$CLIENT_ID"     ]] || fail "GITHUB_CLIENT_ID is required."
[[ -n "$CLIENT_SECRET" ]] || fail "GITHUB_CLIENT_SECRET is required."

if [[ -z "$AUTH_SECRET" ]]; then
  if check_cmd openssl; then
    AUTH_SECRET="$(openssl rand -hex 32)"
  else
    # /dev/urandom fallback
    AUTH_SECRET="$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 64)"
  fi
  info "Generated a fresh BETTER_AUTH_SECRET"
fi

# Upsert the three managed keys, preserving any other keys the user added.
upsert_env() {
  local file="$1" key="$2" value="$3"
  if [[ -f "$file" ]] && grep -q -E "^$key=" "$file"; then
    # Replace in place. `|` delimiter avoids escaping slashes in secrets.
    local tmp; tmp="$(mktemp)"
    awk -v key="$key" -v value="$value" 'BEGIN{FS=OFS="="}
      $1 == key { print key "=" value; seen=1; next }
      { print }
      END { if (!seen) print key "=" value }' "$file" > "$tmp"
    mv "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# Back up any existing .env on first install in case the user had prior values
# we didn't expect to read.
if [[ -f .env && ! -f .env.revv-backup ]]; then
  cp .env .env.revv-backup
fi

[[ -f .env ]] || {
  printf '# Managed by install-macos.sh on %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > .env
}

upsert_env .env GITHUB_CLIENT_ID     "$CLIENT_ID"
upsert_env .env GITHUB_CLIENT_SECRET "$CLIENT_SECRET"
upsert_env .env BETTER_AUTH_SECRET   "$AUTH_SECRET"
chmod 600 .env
success ".env ready ($(wc -l < .env | tr -d ' ') lines)"

# ── 6. Run the existing dev-env installer for toolchain + deps ─
step "Installing build toolchain (delegating to ./install.sh)"
[[ -x ./install.sh ]] || chmod +x ./install.sh
# --skip-env because we wrote .env ourselves, --yes for non-interactive tool installs.
./install.sh --yes --skip-env

# Make sure bun/cargo are in PATH for the rest of THIS script
# (install.sh ran in a subshell; its PATH export doesn't persist here).
if [[ -d "$HOME/.bun/bin" ]]; then
  export PATH="$HOME/.bun/bin:$PATH"
fi
if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

check_cmd bun   || fail "bun not found on PATH after install.sh ran."
check_cmd cargo || fail "cargo not found on PATH after install.sh ran."

# ── 7. Build the .app bundle (skip DMG) ──────────────────────
#
# We deliberately do NOT run `make dist`. That target invokes
# `tauri build` with the default `bundle.targets: "all"`, which
# also produces a .dmg via create-dmg's `bundle_dmg.sh`. That script
# is fragile with paths containing spaces or parentheses (e.g.
# "Revv (Alpha).app" under "~/Library/Application Support/..."),
# and the installer copies the .app directly to /Applications — it
# never uses the DMG. Build the .app only with `--bundles app`.
step "Building the .app bundle (first run takes a few minutes)"
(
  cd "$INSTALL_DIR/packages/shared" && bun run typecheck
)
(
  cd "$INSTALL_DIR" && bun run build
)
(
  cd "$INSTALL_DIR/apps/desktop" && bunx tauri build --bundles app
)

# Tauri writes the .app to bundle/macos/ with a name derived from
# `productName` in tauri.conf.json (e.g. "Revv.app", "Revv (Alpha).app").
# Discover whatever was produced rather than hardcoding a name.
BUNDLE_MACOS_DIR="$INSTALL_DIR/apps/desktop/target/release/bundle/macos"
BUNDLE_APP="$(find "$BUNDLE_MACOS_DIR" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -1)"
if [[ -z "$BUNDLE_APP" ]]; then
  # Fallback: cross-compiled builds land under a target-triple subdir.
  BUNDLE_APP="$(find "$INSTALL_DIR/apps/desktop/target" -maxdepth 6 -type d -name '*.app' -path '*/bundle/macos/*' 2>/dev/null | head -1)"
fi
[[ -n "$BUNDLE_APP" && -d "$BUNDLE_APP" ]] || fail "Build finished but no .app was found under $BUNDLE_MACOS_DIR"
APP_NAME="$(basename "$BUNDLE_APP")"
APP_PROCESS_NAME="${APP_NAME%.app}"
success "Built $BUNDLE_APP"

# ── 8. Install the .app to /Applications (or ~/Applications) ─
step "Installing $APP_NAME"

# Decide target: /Applications if writable, else ~/Applications.
if [[ -w "$APP_DIR" ]]; then
  DEST_APP_DIR="$APP_DIR"
else
  warn "$APP_DIR is not writable without sudo — falling back to ~/Applications"
  DEST_APP_DIR="$HOME/Applications"
  mkdir -p "$DEST_APP_DIR"
fi
DEST_APP="$DEST_APP_DIR/$APP_NAME"

# Remove quarantine attrs preemptively — the app is locally built but macOS
# may still flag it since it's not notarized.
xattr -cr "$BUNDLE_APP" 2>/dev/null || true

# Stop the running LaunchAgent before replacing, in case a prior install exists.
launchctl unload "$LAUNCH_AGENT_PLIST" 2>/dev/null || true
# If the app is currently running, quit it so we can replace it.
osascript -e "tell application \"$APP_PROCESS_NAME\" to quit" 2>/dev/null || true
# Give it a moment.
sleep 1

if [[ -d "$DEST_APP" ]]; then
  rm -rf "$DEST_APP"
fi
cp -R "$BUNDLE_APP" "$DEST_APP"
xattr -cr "$DEST_APP" 2>/dev/null || true
success "Installed → $DEST_APP"

# ── 9. LaunchAgent so the server runs in the background ─────
step "Installing background service (LaunchAgent)"

mkdir -p "$LAUNCH_AGENT_DIR" "$LOG_DIR"

BUN_BIN="$HOME/.bun/bin/bun"
[[ -x "$BUN_BIN" ]] || BUN_BIN="$(command -v bun)"
[[ -x "$BUN_BIN" ]] || fail "Cannot locate bun executable for the LaunchAgent."

SERVER_ENTRY="$INSTALL_DIR/apps/server/src/index.ts"
[[ -f "$SERVER_ENTRY" ]] || fail "Server entry point missing: $SERVER_ENTRY"

# Render plist (avoid sed to keep it simple — use a heredoc with $vars).
cat > "$LAUNCH_AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LAUNCH_AGENT_LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>$BUN_BIN</string>
        <string>run</string>
        <string>apps/server/src/index.ts</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>

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
    <string>$LOG_DIR/server.out.log</string>

    <key>StandardErrorPath</key>
    <string>$LOG_DIR/server.err.log</string>
</dict>
</plist>
PLIST

# Load (or reload if already loaded).
launchctl unload "$LAUNCH_AGENT_PLIST" 2>/dev/null || true
launchctl load -w "$LAUNCH_AGENT_PLIST"
success "LaunchAgent loaded ($LAUNCH_AGENT_LABEL)"

# Wait briefly for the server to come up so the first app launch succeeds.
info "Waiting for API server on http://localhost:45678…"
for i in {1..30}; do
  if curl -fsS --max-time 1 "http://localhost:45678/" >/dev/null 2>&1 \
     || curl -fsS --max-time 1 "http://localhost:45678/api/health" >/dev/null 2>&1 \
     || nc -z 127.0.0.1 45678 >/dev/null 2>&1; then
    success "Server is listening"
    break
  fi
  sleep 1
  if [[ $i -eq 30 ]]; then
    warn "Server didn't respond within 30s. Check logs: tail -f '$LOG_DIR/server.err.log'"
  fi
done

# ── 10. Write install config + install the `revv` CLI ──────
step "Installing revv CLI"

CONFIG_DIR="$HOME/Library/Application Support/Revv"
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/config" <<CFG
# Managed by install-macos.sh. The revv CLI reads SOURCE_DIR from here so
# that subsequent 'revv update' / 'revv status' calls find the right tree
# even when the installer was run from a non-default location.
SOURCE_DIR="$INSTALL_DIR"
APP_PATH="$DEST_APP"
INSTALLED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
CFG
success "Wrote $CONFIG_DIR/config"

mkdir -p "$CLI_DIR"
cp "$INSTALL_DIR/scripts/revv" "$CLI_DIR/revv"
chmod +x "$CLI_DIR/revv"
success "Installed → $CLI_DIR/revv"

# Offer to add ~/.local/bin to PATH if it isn't already.
if ! printf '%s' ":$PATH:" | grep -q ":$CLI_DIR:"; then
  SHELL_RC=""
  case "${SHELL##*/}" in
    zsh)  SHELL_RC="$HOME/.zshrc" ;;
    bash) SHELL_RC="$HOME/.bashrc" ;;
  esac
  if [[ -n "$SHELL_RC" ]] && ! grep -qs "\\.local/bin" "$SHELL_RC" 2>/dev/null; then
    if confirm "Add $CLI_DIR to your PATH in $SHELL_RC?"; then
      {
        printf '\n# Added by Revv installer\n'
        printf 'export PATH="%s:$PATH"\n' "$CLI_DIR"
      } >> "$SHELL_RC"
      success "Updated $SHELL_RC — open a new terminal for it to take effect."
    fi
  else
    warn "$CLI_DIR is not on your PATH. Add this to your shell rc:"
    printf "    export PATH=\"%s:\$PATH\"\n" "$CLI_DIR"
  fi
fi

# ── 11. Launch the app ───────────────────────────────────────
step "Launching Revv"
open "$DEST_APP" || warn "Could not auto-launch. Open it from $DEST_APP_DIR manually."

# ── 12. Summary ──────────────────────────────────────────────
printf "\n%s%s" "$BOLD" "$GREEN"
printf "  ┌────────────────────────────────────────┐\n"
printf "  │   ✓  Revv installed successfully       │\n"
printf "  └────────────────────────────────────────┘\n"
printf "%s\n" "$RESET"

printf "  %sApp:%s        %s\n" "$BOLD" "$RESET" "$DEST_APP"
printf "  %sSource:%s     %s\n" "$BOLD" "$RESET" "$INSTALL_DIR"
printf "  %sServer:%s     loaded as %s (http://localhost:45678)\n" "$BOLD" "$RESET" "$LAUNCH_AGENT_LABEL"
printf "  %sLogs:%s       %s\n" "$BOLD" "$RESET" "$LOG_DIR"
printf "\n  %sManage with the 'revv' CLI:%s\n" "$BOLD" "$RESET"
printf "    %s\$%s revv status      show app + server status\n" "$DIM" "$RESET"
printf "    %s\$%s revv update      pull latest, rebuild, reinstall\n" "$DIM" "$RESET"
printf "    %s\$%s revv restart     restart the API server\n" "$DIM" "$RESET"
printf "    %s\$%s revv logs        tail server logs\n" "$DIM" "$RESET"
printf "    %s\$%s revv uninstall   remove everything\n\n" "$DIM" "$RESET"
