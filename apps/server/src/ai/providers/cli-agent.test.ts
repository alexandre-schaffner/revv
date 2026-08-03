import { describe, expect, it } from "bun:test";
import { serverEnv } from "../../config";
import { resolveClaudeConfigDir } from "../acp/claude-config";
import { claudeStatusCommandEnv } from "./cli-agent";

// ── claudeStatusCommandEnv ───────────────────────────────────────────────────
//
// The `claude auth status` probe's env MUST carry the same `CLAUDE_CONFIG_DIR`
// the agent will actually spawn with — Claude Code's Keychain-backed OAuth
// item is scoped per resolved config dir, so a probe run under a different dir
// reads the wrong (or no) Keychain item and reports logged-out even when the
// isolated dir's own login succeeded. This was the root cause of an
// isolation-breaks-auth regression; these tests pin the fix.

describe("claudeStatusCommandEnv", () => {
  it("injects CLAUDE_CONFIG_DIR consistently with resolveClaudeConfigDir", () => {
    const env = claudeStatusCommandEnv();
    expect(env.CLAUDE_CONFIG_DIR).toBe(resolveClaudeConfigDir("claude-code"));
  });

  it("still omits the requested keys", () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "should-be-omitted";
    try {
      const env = claudeStatusCommandEnv(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBe(resolveClaudeConfigDir("claude-code"));
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
    }
  });

  it("matches serverEnv's isolation setting: no dir at all when isolation is off", () => {
    if (serverEnv.claudeConfigIsolation) return;
    const env = claudeStatusCommandEnv();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});
