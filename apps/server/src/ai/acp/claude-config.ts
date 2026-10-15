// ── Claude config-dir isolation ──────────────────────────────────────────────
//
// Claude Code (and, via it, ecosystem tooling) keeps a session registry under
// `~/.claude/projects`, one entry per working directory it has ever been run
// in. VS Code's Copilot Chat extension force-opens the git repository of
// every workspace it finds listed there — so every PR worktree Revv spawned a
// claude-code ACP agent in showed up, uninvited, in the user's Source Control
// view, with no way to close it back out.
//
// Pointing `CLAUDE_CONFIG_DIR` at a Revv-private directory (injected in
// `presets.ts`, configured in `config.ts`) keeps Revv's sessions out of
// `~/.claude` entirely. Conductor uses the same trick for its own worktrees
// (`~/.conductor`).
//
// This module only prepares that directory before an agent spawns into it —
// it stores no credential of its own. Everything the user configured under
// their real `~/.claude` that Claude Code resolves from `$CLAUDE_CONFIG_DIR`
// — credentials, skills, commands, subagents, plugins — is made reachable
// from the isolated dir via a symlink, never a copy. A copy of
// `.credentials.json` goes stale the next time Claude Code refreshes the
// OAuth token; a copy of `skills/` goes stale the moment the user edits a
// skill.
//
// Isolation is about the session *registry*, not about the user's toolbox.
// Linking nothing but the credentials meant the agent Revv spawned saw only
// the checkout's own `.claude/skills` plus the CLI built-ins: a user-level
// skill (`~/.claude/skills/make-pr-easy-to-review`) was offered by `claude`
// in a terminal and absent from Revv's `/` menu, for no reason the user could
// see.
//
// macOS Keychain auth is NOT global across config dirs, as first assumed —
// confirmed empirically (see the runbook). Claude Code scopes its
// Keychain-backed OAuth item to the resolved config dir: the true default
// (`CLAUDE_CONFIG_DIR` unset, reading `~/.claude.json`) stores under the
// service name `Claude Code-credentials`, while ANY explicit `CLAUDE_CONFIG_DIR`
// — including a literal `~/.claude` — gets its own `Claude Code-credentials-
// <hash>` service. Seeding `.claude.json` with copied account metadata does
// NOT unlock the default item; the isolated dir needs its OWN one-time login
// (`resolveClaudeConfigDir` below is the shared resolution that keeps the
// probe, the login PTY, and the agent spawn all pointed at the same dir, so
// that one-time login lands where the spawn will actually look for it).

import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AcpAgentId } from "@revv/shared";
import { serverEnv } from "../../config";
import { logError } from "../../logger";

const GLOBAL_CLAUDE_DIR = join(homedir(), ".claude");

/**
 * Entries symlinked from the user's real `~/.claude` into the isolated dir —
 * user-level auth and customization, all of which Claude Code resolves from
 * `$CLAUDE_CONFIG_DIR`. Missing entries are skipped, so this is safe on a
 * machine that has never installed a plugin or written a skill.
 *
 * Deliberately NOT linked: `projects/`, `sessions/`, `history.jsonl` and
 * friends. That registry is the entire reason the dir is isolated (see the
 * module header) — linking it back would re-pollute the user's Source
 * Control view with every PR worktree. `settings.json` also stays out: it
 * carries hooks, permissions and MCP servers, which change how the agent
 * behaves rather than what the user can ask it to do, and Revv drives those
 * itself.
 */
const LINKED_ENTRIES = [
  // File-based auth — see the module header on why this is a link.
  ".credentials.json",
  // The user's toolbox: skills, slash commands, subagents, and the plugins
  // that carry their own. Linked (not copied) so an edit in `~/.claude` is
  // live in Revv's next turn.
  "skills",
  "commands",
  "agents",
  "plugins",
  // User-level memory, applied on top of the checkout's own CLAUDE.md.
  "CLAUDE.md",
] as const;

/**
 * The isolated `CLAUDE_CONFIG_DIR` to use for a given ACP agent, or
 * `undefined` when isolation doesn't apply — any agent other than
 * `claude-code`, or `REVV_CLAUDE_CONFIG_ISOLATION=false`.
 *
 * This is the ONE resolution shared by every place that touches claude-code's
 * config dir: `acp-connection.ts` (spawns the agent), `cli-agent.ts` (probes
 * whether subscription auth is verified), and `AgentLogin.ts` (drives the
 * interactive login PTY). They must all agree — see the module header above
 * for why a mismatch surfaces as a false "Authentication required".
 */
export function resolveClaudeConfigDir(agent: AcpAgentId): string | undefined {
  return agent === "claude-code" && serverEnv.claudeConfigIsolation
    ? serverEnv.claudeConfigDir
    : undefined;
}

/**
 * Prepare an isolated `CLAUDE_CONFIG_DIR` so a claude-code ACP agent registers
 * its session there instead of the shared `~/.claude`, while still reaching
 * the user's own credentials and toolbox ({@link LINKED_ENTRIES}). Idempotent
 * — safe to call before every spawn, since each step is a no-op once the
 * directory is seeded.
 *
 * Never throws: a failure here (e.g. a symlink race against a concurrent
 * spawn, or a permissions error) only means the agent falls back to its own
 * onboarding/auth prompt inside the isolated dir — recoverable — so each step
 * is guarded and logged rather than failing the whole connection.
 *
 * `globalDir` overrides the source of the links; it exists for the tests, so
 * they can assert the link set without reading the developer's real
 * `~/.claude`.
 */
export function ensureClaudeConfigDir(dir: string, globalDir: string = GLOBAL_CLAUDE_DIR): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    logError(
      "claude-config",
      "failed to create isolated config dir:",
      dir,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  try {
    const onboardingPath = join(dir, ".claude.json");
    if (!existsSync(onboardingPath)) {
      writeFileSync(onboardingPath, JSON.stringify({ hasCompletedOnboarding: true }));
    }
  } catch (err) {
    logError(
      "claude-config",
      "failed to seed onboarding marker:",
      err instanceof Error ? err.message : String(err),
    );
  }

  for (const entry of LINKED_ENTRIES) {
    try {
      const target = join(globalDir, entry);
      const link = join(dir, entry);
      // `existsSync` follows the link, so an entry already linked (or one the
      // user created by hand inside the isolated dir) is left alone.
      if (!existsSync(target) || existsSync(link)) continue;
      symlinkSync(target, link);
    } catch (err) {
      // A concurrent spawn may have created the symlink between the existsSync
      // check above and this call — the entry is reachable either way.
      logError(
        "claude-config",
        `failed to link ${entry}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
