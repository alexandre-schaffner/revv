#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Revv — Unified Installer
#
# One script, two audiences:
#
#   Curl-piped (end user) — use the signed release installer instead:
#     curl -fsSL https://github.com/alexandre-schaffner/revv/releases/latest/download/install.sh | bash
#
#   From a checkout (developer):
#     ./install.sh --dev       # toolchain + bun install, stop there
#     ./install.sh             # full install (release .app, LaunchAgent, CLI)
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
#   REVV_RELEASE_TAG      Release tag for the pre-built app bundle (default: latest nightly)
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
REVV_RELEASE_TAG="${REVV_RELEASE_TAG:-}"
REVV_APP_DIR="${REVV_APP_DIR:-/Applications}"
REVV_AUTO_YES="${REVV_AUTO_YES:-0}"
MODE="user"   # user | dev
REVV_GITHUB_REPO="alexandre-schaffner/revv"

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
  _R=$'\033[0m'; _B=$'\033[1m'; _D=$'\033[2m'
  _RED=$'\033[31m'; _GREEN=$'\033[32m'; _YELLOW=$'\033[33m'
  _CYAN=$'\033[36m'
else
  _R="" _B="" _D="" _RED="" _GREEN="" _YELLOW="" _CYAN=""
fi
_info()    { printf "  ${_CYAN}·${_R}  %s\n"  "$*"; }
_success() { printf "  ${_GREEN}✓${_R}  %s\n" "$*"; }
_warn()    { printf "  ${_YELLOW}⚠${_R}  %s\n" "$*" >&2; }
_fail()    { printf "\n  ${_RED}✗${_R}  %s\n\n" "$*" >&2; exit 1; }
_step()    { printf "\n  ${_B}%s${_R}\n" "$*"; }

_check_cmd() { command -v "$1" >/dev/null 2>&1; }

_latest_release_tag() {
  local tag
  tag="$(curl -fsSL "https://api.github.com/repos/${REVV_GITHUB_REPO}/releases/latest" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -1)"
  [[ -n "$tag" ]] || return 1
  printf '%s' "$tag"
}

_latest_nightly_tag() {
  local tag
  tag="$(curl -fsSL "https://api.github.com/repos/${REVV_GITHUB_REPO}/releases?per_page=30" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(nightly-[^"]*\)".*/\1/p' \
    | head -1)"
  [[ -n "$tag" ]] || return 1
  printf '%s' "$tag"
}

# ── Banner ────────────────────────────────────────────────────
printf "\n"
printf "  ${_CYAN}${_B}██████╗ ███████╗██╗   ██╗██╗   ██╗${_R}\n"
printf "  ${_CYAN}${_B}██╔══██╗██╔════╝██║   ██║██║   ██║${_R}\n"
printf "  ${_CYAN}${_B}██████╔╝█████╗  ██║   ██║██║   ██║${_R}\n"
printf "  ${_CYAN}${_B}██╔══██╗██╔══╝  ╚██╗ ██╔╝╚██╗ ██╔╝${_R}\n"
printf "  ${_CYAN}${_B}██║  ██║███████╗ ╚████╔╝  ╚████╔╝ ${_R}\n"
printf "  ${_CYAN}${_B}╚═╝  ╚═╝╚══════╝  ╚═══╝    ╚═══╝  ${_R}\n"
printf "\n"
if [[ "$MODE" == "dev" ]]; then
  printf "  ${_D}AI-powered code review${_R}  ${_B}dev setup${_R}\n"
else
  printf "  ${_D}AI-powered code review${_R}  ${_B}installer${_R}\n"
fi
printf "\n"
printf "  ${_D}"
printf '─%.0s' {1..54}
printf "${_R}\n\n"

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

  clone_ref="$REVV_BRANCH"
  if [[ "$MODE" == "user" && -z "${REVV_RELEASE_TAG:-}" ]]; then
    REVV_RELEASE_TAG="$(_latest_nightly_tag || _latest_release_tag || true)"
  fi
  if [[ "$MODE" == "user" && -n "${REVV_RELEASE_TAG:-}" ]]; then
    clone_ref="$REVV_RELEASE_TAG"
    _info "Using release $REVV_RELEASE_TAG"
  fi

  dest="${REVV_INSTALL_DIR:-$HOME/Library/Application Support/Revv/src}"
  mkdir -p "$(dirname "$dest")"
  if [[ -d "$dest/.git" ]]; then
    _info "Existing clone at $dest — updating"
    git -C "$dest" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
    git -C "$dest" fetch --all --prune
    git -C "$dest" fetch --tags --force
    git -C "$dest" checkout "$clone_ref"
    if [[ "$clone_ref" == "$REVV_BRANCH" ]]; then
      git -C "$dest" reset --hard "origin/$REVV_BRANCH"
    else
      git -C "$dest" reset --hard "$clone_ref"
    fi
  elif [[ -e "$dest" ]]; then
    _fail "$dest exists but is not a git clone. Move it aside and re-run."
  else
    _info "Cloning $REVV_REPO_URL ($REVV_BRANCH) → $dest"
    git clone --branch "$REVV_BRANCH" --depth 50 "$REVV_REPO_URL" "$dest"
    if [[ "$clone_ref" != "$REVV_BRANCH" ]]; then
      git -C "$dest" fetch --tags --force
      git -C "$dest" checkout "$clone_ref"
      git -C "$dest" reset --hard "$clone_ref"
    fi
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
if [[ "$MODE" == "dev" ]]; then
  ensure_rust
fi

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

# Verify workspace deps actually landed in node_modules (Bun's workspace
# hoisting can leave stale trees when the lockfile changes under a warm cache).
_verify_workspace_deps() {
  local missing=()
  # Critical frontend deps that have caused runtime crashes when absent
  [[ -d "node_modules/gsap" ]] || missing+=("gsap")
  [[ -d "node_modules/phosphor-svelte" ]] || missing+=("phosphor-svelte")
  if [[ ${#missing[@]} -gt 0 ]]; then
    warn "Some workspace dependencies are missing from node_modules: ${missing[*]}"
    if confirm "Force a clean reinstall (rm -rf node_modules && bun install)?"; then
      info "Clearing node_modules and reinstalling…"
      rm -rf node_modules apps/web/node_modules apps/server/node_modules packages/shared/node_modules
      bun install
      success "Clean reinstall complete"
    else
      warn "Continuing with incomplete node_modules — builds may fail"
    fi
  fi
}
_verify_workspace_deps

# ── 5. Dev mode exits here ────────────────────────────────────
if [[ "$MODE" == "dev" ]]; then
  # Warn about stale dev DBs that can crash migrations on first dev-server start.
  for stale_db in "apps/server/revv-dev.db" "revv-dev.db"; do
    if [[ -f "$stale_db" ]]; then
      warn "A dev database already exists at $stale_db."
      info "If the server crashes with a migration error on startup, run:"
      info "  make reset-db"
      break
    fi
  done

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

_resolve_install_release_tag() {
  if [[ -n "${REVV_RELEASE_TAG:-}" ]]; then
    printf '%s' "$REVV_RELEASE_TAG"
    return 0
  fi
  local exact_tag
  exact_tag="$(git -C "$PROJECT_ROOT" describe --tags --exact-match HEAD 2>/dev/null || true)"
  if [[ -n "$exact_tag" ]]; then
    printf '%s' "$exact_tag"
    return 0
  fi
  return 1
}

_install_prebuilt_app() {
  local release_tag="$1" asset_arch release_json bundle_url bundle_sha bundle_file actual_sha mount_point app_source install_dir installed_app
  [[ -n "$release_tag" ]] || return 1
  case "$(uname -m)" in
    arm64|aarch64) asset_arch="aarch64" ;;
    x86_64)        asset_arch="x64" ;;
    *)             return 1 ;;
  esac

  release_json="$(mktemp)"
  curl -fsSL \
    "https://api.github.com/repos/${REVV_GITHUB_REPO}/releases/tags/${release_tag}" \
    -o "$release_json" || { rm -f "$release_json"; return 1; }
  bundle_url="$(sed -n "s/.*\"browser_download_url\": \"\([^\"]*_${asset_arch}\.dmg\)\".*/\1/p" "$release_json" | head -1)"
  bundle_sha="$(sed -n "/\"name\": \".*_${asset_arch}\.dmg\"/,/\"browser_download_url\"/ s/.*\"digest\": *\"sha256:\([a-fA-F0-9]*\)\".*/\1/p" "$release_json" | head -1)"
  rm -f "$release_json"
  [[ -n "$bundle_url" ]] || return 1

  # Fast-path: per-asset digest from GitHub API. Fallback: SHA256SUMS file.
  if [[ -z "$bundle_sha" ]]; then
    local sums_file sums_url bundle_filename
    sums_url="https://github.com/${REVV_GITHUB_REPO}/releases/download/${release_tag}/SHA256SUMS"
    sums_file="$(mktemp)"
    if curl -fsSL "$sums_url" -o "$sums_file" 2>/dev/null; then
      bundle_filename="$(basename "$bundle_url")"
      bundle_sha="$(awk -v name="$bundle_filename" '$2 == name {print $1}' "$sums_file" | head -1)"
    fi
    rm -f "$sums_file"
  fi

  bundle_file="$(mktemp).dmg"
  info "Downloading pre-built Revv.app from ${release_tag} (${asset_arch})"
  curl -fL "$bundle_url" -o "$bundle_file" || { rm -f "$bundle_file"; return 1; }
  if [[ -n "$bundle_sha" ]]; then
    actual_sha="$(shasum -a 256 "$bundle_file" | awk '{print $1}')"
    if [[ "$actual_sha" != "$bundle_sha" ]]; then
      rm -f "$bundle_file"
      fail "Downloaded DMG checksum mismatch for ${release_tag}."
    fi
  else
    warn "SHA256SUMS unavailable for ${release_tag}; installing without checksum verification."
  fi

  mount_point="$(mktemp -d)"
  hdiutil attach -quiet -nobrowse -mountpoint "$mount_point" "$bundle_file" || {
    rm -rf "$mount_point" "$bundle_file"
    return 1
  }
  app_source="$(find "$mount_point" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -1)"
  if [[ -z "$app_source" ]]; then
    hdiutil detach -quiet "$mount_point" 2>/dev/null || true
    rm -rf "$mount_point" "$bundle_file"
    return 1
  fi

  install_dir="$REVV_APP_DIR"
  [[ -w "$install_dir" ]] || install_dir="$HOME/Applications"
  mkdir -p "$install_dir"
  installed_app="$install_dir/$(basename "$app_source")"
  rm -rf "$installed_app"
  cp -R "$app_source" "$installed_app"
  xattr -cr "$installed_app" 2>/dev/null || true
  hdiutil detach -quiet "$mount_point" 2>/dev/null || true
  rm -rf "$mount_point" "$bundle_file"
}

_find_installed_app() {
  local candidate
  for candidate in "$REVV_APP_DIR"/Revv*.app "$HOME/Applications"/Revv*.app /Applications/Revv*.app; do
    [[ -d "$candidate" ]] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

step "Installing pre-built Revv.app"
release_tag="$(_resolve_install_release_tag || true)"
if ! _install_prebuilt_app "$release_tag"; then
  warn "Could not install a pre-built app bundle; falling back to a local build."
  ensure_rust
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
else
  dest_app="$(_find_installed_app)" || fail "Release bundle installed but no Revv.app was found."
  app_name="$(basename "$dest_app")"
  app_process_name="${app_name%.app}"
  dest_app_dir="$(dirname "$dest_app")"
  success "Installed → $dest_app"
fi

# Revv bundles a GitHub OAuth App registered on nocturlab.ghe.com — the host
# and client_id defaults live in apps/server/src/config.ts and are baked into
# the server. No installer prompt.
#
# Power users can target a different GitHub instance by exporting both
# REVV_GITHUB_HOST and REVV_GITHUB_CLIENT_ID before running the installer:
#
#   curl -fsSL …/install.sh | \
#     REVV_GITHUB_HOST=github.com \
#     REVV_GITHUB_CLIENT_ID=<your-oauth-app-client-id> bash
#
# When set, we persist them to $REVV_SUPPORT_DIR/github.conf so `revv update`
# regenerates the LaunchAgent plist with the same overrides. When unset, we
# wipe any stale conf so the bundled defaults win.
mkdir -p "$REVV_SUPPORT_DIR"
if [[ -n "${REVV_GITHUB_HOST:-}" || -n "${REVV_GITHUB_CLIENT_ID:-}" ]]; then
  {
    [[ -n "${REVV_GITHUB_HOST:-}"      ]] && printf 'GITHUB_HOST=%s\n'      "$REVV_GITHUB_HOST"
    [[ -n "${REVV_GITHUB_CLIENT_ID:-}" ]] && printf 'GITHUB_CLIENT_ID=%s\n' "$REVV_GITHUB_CLIENT_ID"
  } > "$REVV_SUPPORT_DIR/github.conf"
  chmod 600 "$REVV_SUPPORT_DIR/github.conf"
  success "GitHub overrides persisted → $REVV_SUPPORT_DIR/github.conf (host: ${REVV_GITHUB_HOST:-<bundled>})"
  export REVV_GITHUB_HOST="${REVV_GITHUB_HOST:-}"
  export REVV_GITHUB_CLIENT_ID="${REVV_GITHUB_CLIENT_ID:-}"
else
  rm -f "$REVV_SUPPORT_DIR/github.conf" 2>/dev/null || true
fi

# ── 7. LaunchAgent ────────────────────────────────────────────
step "Installing background service (LaunchAgent)"
mkdir -p "$(dirname "$REVV_LAUNCH_AGENT_PLIST")" "$REVV_LOG_DIR"
bun_bin="$HOME/.bun/bin/bun"
[[ -x "$bun_bin" ]] || bun_bin="$(command -v bun || true)"
[[ -x "$bun_bin" ]] || fail "Cannot locate bun executable for the LaunchAgent."
server_entry="$PROJECT_ROOT/apps/server/src/index.ts"
[[ -f "$server_entry" ]] || fail "Server entry point missing: $server_entry"

write_launch_agent_plist \
  "$REVV_LAUNCH_AGENT_PLIST" \
  "$bun_bin" \
  "$PROJECT_ROOT" \
  "$REVV_LOG_DIR"

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
printf '    %s$%s revv update      install the latest channel build\n' "$REVV_DIM" "$REVV_RESET"
printf '    %s$%s revv restart     restart the API server\n'      "$REVV_DIM" "$REVV_RESET"
printf '    %s$%s revv logs        tail server logs\n'            "$REVV_DIM" "$REVV_RESET"
printf '    %s$%s revv uninstall   remove everything\n\n'         "$REVV_DIM" "$REVV_RESET"
