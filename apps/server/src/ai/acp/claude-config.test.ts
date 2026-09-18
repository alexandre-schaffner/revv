import { describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverEnv } from "../../config";
import { ensureClaudeConfigDir, resolveClaudeConfigDir } from "./claude-config";

// ── resolveClaudeConfigDir ───────────────────────────────────────────────────
//
// The single resolution shared by the agent spawn (`acp-connection.ts`), the
// subscription-auth probe (`cli-agent.ts`), and the login PTY
// (`AgentLogin.ts`). A regression here (e.g. losing the `agent === "claude-code"`
// guard, or drifting from `serverEnv`) breaks all three at once — exactly the
// mismatch that caused isolation to break Keychain-backed auth.

describe("resolveClaudeConfigDir", () => {
  it("never resolves a dir for a non-claude-code agent, regardless of the isolation setting", () => {
    for (const agent of ["codex", "opencode", "cursor"] as const) {
      expect(resolveClaudeConfigDir(agent)).toBeUndefined();
    }
  });

  it("resolves claude-code consistently with serverEnv.claudeConfigIsolation", () => {
    const expected = serverEnv.claudeConfigIsolation ? serverEnv.claudeConfigDir : undefined;
    expect(resolveClaudeConfigDir("claude-code")).toBe(expected);
  });
});

// ── ensureClaudeConfigDir ────────────────────────────────────────────────────

describe("ensureClaudeConfigDir", () => {
  it("creates the dir (mode 0700) and seeds an onboarding-only .claude.json", async () => {
    const base = mkdtempSync(join(tmpdir(), "revv-claude-config-"));
    const dir = join(base, "claude");
    try {
      ensureClaudeConfigDir(dir);

      expect(existsSync(dir)).toBe(true);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);

      const onboardingPath = join(dir, ".claude.json");
      expect(existsSync(onboardingPath)).toBe(true);
      expect(JSON.parse(readFileSync(onboardingPath, "utf8"))).toEqual({
        hasCompletedOnboarding: true,
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("is idempotent — a second call on an already-seeded dir is a no-op", async () => {
    const base = mkdtempSync(join(tmpdir(), "revv-claude-config-"));
    const dir = join(base, "claude");
    try {
      ensureClaudeConfigDir(dir);
      const onboardingPath = join(dir, ".claude.json");
      // Simulate the CLI having since rewritten its own state into the file —
      // a second `ensureClaudeConfigDir` call must not clobber it.
      writeFileSync(
        onboardingPath,
        JSON.stringify({ hasCompletedOnboarding: true, extra: "cli-state" }),
      );

      ensureClaudeConfigDir(dir);

      expect(JSON.parse(readFileSync(onboardingPath, "utf8"))).toEqual({
        hasCompletedOnboarding: true,
        extra: "cli-state",
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("never throws when the parent dir doesn't exist", () => {
    const dir = join(tmpdir(), "revv-claude-config-missing-parent", "nested", "claude");
    expect(() => ensureClaudeConfigDir(dir)).not.toThrow();
  });

  // The regression this guards: with only `.credentials.json` linked, an agent
  // spawned into the isolated dir saw none of the user's skills, so Revv's `/`
  // menu offered a strictly smaller set than the same user's `claude` in a
  // terminal. The session registry must stay unlinked all the same — that's
  // what isolation is for.
  it("links the user's auth + toolbox and nothing from the session registry", async () => {
    const base = mkdtempSync(join(tmpdir(), "revv-claude-config-"));
    const globalDir = join(base, "global");
    const dir = join(base, "claude");
    try {
      for (const entry of ["skills", "commands", "agents", "plugins", "projects", "sessions"]) {
        mkdirSync(join(globalDir, entry), { recursive: true });
      }
      writeFileSync(join(globalDir, ".credentials.json"), "{}");
      writeFileSync(join(globalDir, "CLAUDE.md"), "# user memory");
      writeFileSync(join(globalDir, "settings.json"), "{}");

      ensureClaudeConfigDir(dir, globalDir);

      for (const entry of [
        ".credentials.json",
        "skills",
        "commands",
        "agents",
        "plugins",
        "CLAUDE.md",
      ]) {
        expect(lstatSync(join(dir, entry)).isSymbolicLink()).toBe(true);
      }
      for (const entry of ["projects", "sessions", "settings.json"]) {
        expect(existsSync(join(dir, entry))).toBe(false);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("skips entries the user doesn't have and never replaces an existing one", async () => {
    const base = mkdtempSync(join(tmpdir(), "revv-claude-config-"));
    const globalDir = join(base, "global");
    const dir = join(base, "claude");
    try {
      mkdirSync(join(globalDir, "skills"), { recursive: true });
      mkdirSync(join(globalDir, "commands"), { recursive: true });
      // A real dir already inside the isolated config — e.g. one the CLI wrote
      // itself before this linking existed. Left as-is, not clobbered.
      mkdirSync(join(dir, "commands"), { recursive: true });

      ensureClaudeConfigDir(dir, globalDir);

      expect(lstatSync(join(dir, "skills")).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(dir, "commands")).isSymbolicLink()).toBe(false);
      // `agents`/`plugins`/`CLAUDE.md` don't exist upstream — no dangling links.
      for (const entry of ["agents", "plugins", "CLAUDE.md"]) {
        expect(existsSync(join(dir, entry))).toBe(false);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
