#!/usr/bin/env bash
#
# revv-claude-doctor.sh — diagnose why Revv's Claude Code agent fails to
# authenticate (chat 401 / "ACP connection closed" during report generation).
#
# macOS only. Read-only: it reads settings, keychain metadata (never secrets),
# the LaunchAgent environment, and the server log. Nothing is modified.
#
# Usage:  bash revv-claude-doctor.sh
#
# Send the full output back for interpretation.

# Intentionally NOT `set -e`: every probe is best-effort and must not abort the
# rest of the report if a tool is missing or a lookup fails.
set -u

mask() { sed -E 's/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/\1…masked/g'; }
have() { command -v "$1" >/dev/null 2>&1; }

echo "──────── REVV CLAUDE DIAGNOSTIC ────────"
echo "host: $(sw_vers -productVersion 2>/dev/null || uname -sr)   user: $(id -un)"
echo

# ── 1. Selected agent + whether a credential is stored by Revv ───────────────
echo "## 1. Selected agent (prod DB)"
DB="$HOME/Library/Application Support/Revv/revv.db"
if [ ! -f "$DB" ]; then
  DB=$(find "$HOME/Library/Application Support/Revv" "$HOME/Documents" \
       -maxdepth 5 -name "revv.db" 2>/dev/null | head -1)
fi
echo "db: ${DB:-NOT FOUND}"
if [ -n "${DB:-}" ] && [ -f "$DB" ] && have sqlite3; then
  echo "agent: $(sqlite3 "$DB" 'select ai_agent from user_settings;' 2>/dev/null || echo '?')"
  # agent_credentials_json only exists on builds that include the fix.
  creds=$(sqlite3 "$DB" \
    'select case when agent_credentials_json is null or agent_credentials_json="{}" then "NONE" else "present" end from user_settings;' \
    2>/dev/null)
  echo "stored agent creds: ${creds:-column absent (pre-fix build)}"
elif ! have sqlite3; then
  echo "(sqlite3 not available — skipping DB read)"
fi

# ── 2. Where is the Claude login, and is it keychain-only? ───────────────────
echo
echo "## 2. Claude login location"
if [ -f "$HOME/.claude/.credentials.json" ]; then
  echo "file login: ~/.claude/.credentials.json PRESENT (reachable by the background server)"
else
  echo "file login: ABSENT"
fi
if security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; then
  echo "keychain login: PRESENT (reachability depends on the item's Access Control)"
else
  echo "keychain login: absent"
fi

# ── 2b. Can the trusted `security` binary read it silently? ──────────────────
# Claude Code reads the keychain by shelling out to /usr/bin/security, so the
# item's Access Control usually trusts `security` (not the node/claude binary).
# If `security` is trusted, this read is SILENT (exit 0) and the background
# server succeeds the same way. If `security` is NOT trusted, macOS pops a
# confirmation dialog here — that same block is why the background server 401s.
#   • Silent exit 0            → keychain is readable by the trusted path (not the cause).
#   • A GUI prompt appears     → not trusted; click Deny to observe (Always Allow would
#                                fix it by adding `security`). This IS the failure cause.
echo
echo "## 2b. Silent keychain read via trusted 'security' binary"
if security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; then
  security find-generic-password -w -s "Claude Code-credentials" >/dev/null 2>&1
  rc=$?
  if [ $rc -eq 0 ]; then
    echo "silent read: OK (exit 0) — 'security' is trusted; background server can read it"
  else
    echo "silent read: FAILED/PROMPTED (exit $rc) — 'security' NOT trusted; this is the 401 cause"
  fi
else
  echo "(no Claude keychain item to probe)"
fi

# ── 3. Does the subscription actually verify (interactive shell)? ────────────
echo
echo "## 3. Subscription verification (interactive shell)"
if have claude; then
  claude auth status 2>&1 | head -4
else
  echo "claude CLI not on PATH in this shell"
fi

# ── 4. What the background LaunchAgent server actually runs with ─────────────
echo
echo "## 4. Background server environment + state"
launchctl print "gui/$(id -u)/com.revv.server" 2>/dev/null \
  | grep -iE "state =|last exit|program =|CLAUDE_CODE_OAUTH|ANTHROPIC|OPENAI|REVV_CLAUDE_BIN|path =" \
  | mask \
  || echo "com.revv.server not loaded (is the app running?)"

# ── 5. Stale API key that could shadow a valid subscription ──────────────────
echo
echo "## 5. Stale Anthropic API key in this shell?"
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY set (len=${#ANTHROPIC_API_KEY}) — can shadow a subscription and 401"
elif [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  echo "ANTHROPIC_AUTH_TOKEN set (len=${#ANTHROPIC_AUTH_TOKEN}) — can shadow a subscription and 401"
else
  echo "none in shell"
fi

# ── 6. The actual server error (smoking gun) ─────────────────────────────────
echo
echo "## 6. Recent Claude-relevant server errors"
LOG="$HOME/Library/Logs/Revv/server.err.log"
if [ -f "$LOG" ]; then
  # Claude auth failures look like: 401 / unauthorized / oauth / "connection closed"
  # from the chat/walkthrough/recap ACP drivers or suggestions.
  tail -n 200 "$LOG" \
    | grep -iE "401|unauthor|oauth|invalid authentication|connection closed|acp agent|walkthrough-acp|chat-acp|recap-acp|suggestions" \
    | grep -viE "github|/repos/|org OAuth app policies|403" \
    | tail -n 15 \
    || echo "(no Claude-relevant error lines found)"
  echo "  note: GitHub 401/403 lines were filtered out — those are GitHub sync, not Claude."
else
  echo "no $LOG"
fi

# ── Interpretation ───────────────────────────────────────────────────────────
echo
echo "──────── HOW TO READ THIS ────────"
cat <<'EOF'
Claude reads the keychain via the trusted /usr/bin/security binary, so the
sharp signal is §2b, not "Allow all" vs "Confirm before allowing".

Confirmed keychain-block pattern (the PR fixes this):
  §1  agent = claude-code
  §2  keychain login PRESENT (file login absent)
  §2b silent read FAILED / PROMPTED   ← 'security' not trusted for their item
  §3  loggedIn: true                  (subscription valid interactively)
  §4  NO CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_* in the server env
  §6  a Claude 401 / "ACP connection closed"
→ Background server can't get a silent keychain read. Injecting a stored
  CLAUDE_CODE_OAUTH_TOKEN (the fix) bypasses the keychain entirely.

If §2b is "OK (exit 0)" — as on a working machine — the keychain is NOT the
problem; look at §1 (right agent?), §4 (claude on PATH / REVV_CLAUDE_BIN),
and §6 for the real error.

Definitive GUI check + a remediation to try today:
  Keychain Access → login → "Claude Code-credentials" → Access Control tab.
  If `security` is missing from the allowed list, either add it, or set
  "Allow all applications". If generation then works, that confirms the cause.

Other outcomes:
  §1 agent is cursor/opencode  → different story; not the keychain issue.
  §5 shows an API key set      → the shadowing hazard; the fix drops it.
EOF
echo "──────────────────────────────────"
