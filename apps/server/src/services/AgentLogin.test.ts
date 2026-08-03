import { describe, expect, it } from "bun:test";
import { buildLoginEnv } from "./AgentLogin";

// ── buildLoginEnv ─────────────────────────────────────────────────────────────
//
// The interactive login PTY's env must carry the SAME `CLAUDE_CONFIG_DIR` the
// agent spawn and the auth probe use — a login completed under a different dir
// authenticates the wrong Keychain item and leaves the isolated agent still
// logged out. These tests pin that contract at the pure-function level.

describe("buildLoginEnv", () => {
  it("sets PATH and omits CLAUDE_CONFIG_DIR when isolation doesn't apply", () => {
    const env = buildLoginEnv({ HOME: "/Users/test" }, "/usr/bin:/bin", undefined);
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/Users/test");
    expect("CLAUDE_CONFIG_DIR" in env).toBe(false);
  });

  it("injects CLAUDE_CONFIG_DIR when a claude config dir is resolved", () => {
    const env = buildLoginEnv({}, "/usr/bin", "/Users/test/.revv/claude");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/test/.revv/claude");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("PATH from the argument always wins over an inherited PATH", () => {
    const env = buildLoginEnv({ PATH: "/stale" }, "/fresh", undefined);
    expect(env.PATH).toBe("/fresh");
  });
});
