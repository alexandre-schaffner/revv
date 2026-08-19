import { describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
});
