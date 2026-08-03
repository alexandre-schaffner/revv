# Claude config-dir isolation

## Purpose

VS Code's Copilot Chat extension force-opens the git repository of every
workspace it finds listed under `~/.claude/projects` — Claude Code's own
session registry, one entry per working directory it has ever run in.

Revv's claude-code ACP agent runs in per-PR review worktrees. Every one of
those worktrees registered itself in `~/.claude/projects`, so they kept
popping into the user's VS Code Source Control view as separate git repos,
with no way to close them back out.

Prior art: Conductor isolates its own worktrees the same way, pointing
`CLAUDE_CONFIG_DIR` at `~/.conductor` instead of the shared `~/.claude`.

## Design

- `CLAUDE_CONFIG_DIR` and the on/off toggle are both resolved once in
  `apps/server/src/config.ts`: `serverEnv.claudeConfigDir` (default
  `~/.revv/claude`, overridable via `REVV_CLAUDE_CONFIG_DIR`) and
  `serverEnv.claudeConfigIsolation` (default **on**, the sole escape hatch is
  the `REVV_CLAUDE_CONFIG_ISOLATION` env var — no UI setting, no DB column).
- Everything is centralized at the single point that actually spawns an ACP
  subprocess — `spawnConnection` in `apps/server/src/ai/acp/acp-connection.ts`.
  When the agent id is `claude-code` and isolation is enabled, it resolves
  `claudeConfigDir`, calls `ensureClaudeConfigDir` on it, and passes it as an
  option into `resolveAcpProcessLaunchById` → `buildAcpProcessEnv`
  (`apps/server/src/ai/acp/presets.ts`), which injects `CLAUDE_CONFIG_DIR` only
  for the `claude-code` adapter. Every other ACP agent (codex, opencode,
  cursor) is unaffected, and no caller of `getAcpConnection` (chat, merge-
  conflict resolution, walkthrough, recap, suggestions) passes or knows about
  this option — the callers are unchanged.
- `apps/server/src/ai/acp/claude-config.ts#ensureClaudeConfigDir` prepares the
  directory: creates it (`mode: 0o700`) if missing, seeds `.claude.json` with
  `{"hasCompletedOnboarding": true}` so the agent doesn't hit onboarding, and
  symlinks (never copies) `.credentials.json` from the global `~/.claude`
  directory if the isolated dir doesn't have one yet (the file-based-auth
  fallback — most macOS users are on Keychain auth instead, see below).
- No pool-key involvement needed: since the value is a fixed, process-wide
  server setting (not a per-call option), every `claude-code` connection for
  a given server run gets the same `CLAUDE_CONFIG_DIR` — there's nothing to
  key on. A change to `REVV_CLAUDE_CONFIG_ISOLATION` takes effect on server
  restart.

## Auth mechanism — Keychain storage is scoped PER CONFIG DIR (important)

Initial design assumed macOS Keychain entries are global and unaffected by
`CLAUDE_CONFIG_DIR`. **That assumption was wrong**, and shipping on it broke
Claude Code auth under isolation ("Authentication required" on every
walkthrough, even for an already-logged-in user). Confirmed empirically:

- With `CLAUDE_CONFIG_DIR` unset, Claude reads `~/.claude.json` (the file, a
  sibling of the `.claude/` dir — not inside it) and its Keychain item is
  named `Claude Code-credentials`.
- The moment `CLAUDE_CONFIG_DIR` is set to ANY value — even the literal
  default `~/.claude` — Claude looks for `.claude.json` **inside** that dir
  instead, and (per `security dump-keychain`) stores/reads its OAuth token
  under a **different Keychain service**, named `Claude Code-credentials-
  <8-hex-char-suffix>` (the suffix is derived from the resolved config dir;
  the exact hash algorithm is undocumented and not worth reverse-engineering —
  treat it as an opaque per-dir Keychain scope). This already happens for any
  tool that sets a custom `CLAUDE_CONFIG_DIR` (Conductor's `~/.conductor` gets
  its own scoped item the same way) — it appears to be an intentional
  isolation boundary on Anthropic's side, not a bug.
- Seeding `.claude.json` with copied account/org metadata (even a full
  `oauthAccount` copy) does **not** unlock the default Keychain item for an
  isolated dir — tested directly, still reports logged out. The isolated dir
  needs its **own** one-time login, which creates its own scoped Keychain item.
- There is no `.credentials.json` file involved for Keychain-auth users, in
  either the default or the isolated dir — this is why the credentials-symlink
  fallback in `ensureClaudeConfigDir` is a no-op for most users; it only
  matters for File-based-auth setups.

**The fix**: probe, interactive login, and agent spawn must all run with the
SAME `CLAUDE_CONFIG_DIR`, so they all resolve the same scoped Keychain item.
`apps/server/src/ai/acp/claude-config.ts#resolveClaudeConfigDir(agent)` is the
one shared resolution:
- `apps/server/src/ai/acp/acp-connection.ts#spawnConnection` — the agent spawn.
- `apps/server/src/ai/providers/cli-agent.ts#claudeStatusCommandEnv` — the
  `claude auth status --json` probe behind `detectClaudeSubscriptionAuth`
  (consumed by `presets.ts`'s decision to strip `ANTHROPIC_API_KEY`/
  `ANTHROPIC_AUTH_TOKEN`, and by the onboarding auth-status UI).
- `apps/server/src/services/AgentLogin.ts#buildLoginEnv` — the interactive
  login PTY driving `claude auth login --claudeai`.

## One-time setup (required before first isolated use)

Because the isolated dir gets its own scoped Keychain item, a machine's
**first** Claude walkthrough/chat under isolation needs a one-time login
into that specific dir — it is a genuinely separate OAuth grant from the
user's normal `claude` CLI session (logging in one does not log out the
other, and revoking one does not revoke the other):

- **Via Revv**: trigger Claude sign-in from Revv's normal onboarding/settings
  login flow — it now drives the login PTY with `CLAUDE_CONFIG_DIR` already
  set to the isolated dir, so this is the only step needed.
- **Via CLI** (for manual triage): run
  ```
  CLAUDE_CONFIG_DIR=~/.revv/claude claude
  ```
  then `/login` inside the REPL, and complete the browser OAuth flow. Confirm
  with:
  ```
  CLAUDE_CONFIG_DIR=~/.revv/claude claude auth status --json
  ```
  which should report `"loggedIn": true`.

## Manual verification steps

1. Build and run Revv Desktop with this change.
2. If this is the machine's first isolated Claude use, complete the one-time
   login above.
3. Launch a review on a PR using the Claude agent.
4. Confirm the agent starts with no login/onboarding hang, and the walkthrough
   completes normally.
5. Confirm there is **no** new entry `~/.claude/projects/-Users-<user>--revv-*`
   for this PR's worktree, and a new entry appears instead under
   `~/.revv/claude/projects/`.
6. In VS Code with the Copilot Chat extension enabled, confirm the new PR
   worktree does **not** appear in Source Control.
7. Rollback check: set `REVV_CLAUDE_CONFIG_ISOLATION=false` in the server's
   environment, restart Revv's server process, then start a new chat turn /
   walkthrough with the Claude agent and confirm it now registers under
   `~/.claude/projects/` again.

## Triage: "Authentication required" under isolation

`REVV_CLAUDE_CONFIG_ISOLATION=false` + restart is the standard first triage
step for ANY claude-code auth complaint on an isolation-enabled install:

- If the walkthrough/chat then **succeeds**, isolation is implicated — check
  whether the one-time login (above) has been done on this machine for the
  isolated dir. It hasn't cross-contaminated with the user's normal `claude`
  CLI session, so it genuinely needs its own login once per machine.
- If it **still fails** with isolation off, the problem is unrelated to this
  feature — investigate the user's normal Claude Code auth instead.

## Known limitations

- The manual "check keychain access" probe in Settings
  (`agent-keychain.ts#probeAgentKeychainReadable`, `routes/settings.ts`
  `/agent/keychain-check`) still checks the **default**, unscoped
  `Claude Code-credentials` service name — it was not updated to resolve the
  isolated dir's scoped service name (unknown hash algorithm, not worth
  reverse-engineering). It may report misleading results when isolation is on;
  the `claude auth status --json` probe above is authoritative, this one
  isn't.
- A session started before switching `REVV_CLAUDE_CONFIG_ISOLATION` won't
  resume from the new location — the isolated dir starts with no prior
  session history, and a first-time switch to isolation needs the one-time
  login above.
