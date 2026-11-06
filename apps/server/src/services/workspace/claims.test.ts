import { describe, expect, it } from "bun:test";
import { createWorkspaceClaims, type WorkspaceClaim } from "./claims";

// The regression the expiry exists for: a chat turn claimed the PR's
// worktree, its stream never ran the cleanup that gave the claim back, and
// every push for that PR was refused until the server restarted.

const IDLE_MS = 15 * 60 * 1000;
const PR = "repo-uuid:2945";

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function claimed(result: WorkspaceClaim | string): WorkspaceClaim {
  if (typeof result === "string") throw new Error(`expected a claim, ${result} holds it`);
  return result;
}

describe("createWorkspaceClaims", () => {
  it("refuses a second holder while the first works, naming the first", () => {
    const claims = createWorkspaceClaims(IDLE_MS, fakeClock().now);
    claimed(claims.take(PR, "chat-turn"));
    expect(claims.take(PR, "push")).toBe("chat-turn");
    expect(claims.take(PR, "chat-turn")).toBe("chat-turn");
    expect(claims.holder(PR)).toBe("chat-turn");
  });

  it("gives the workspace back on release, idempotently", () => {
    const claims = createWorkspaceClaims(IDLE_MS, fakeClock().now);
    const claim = claimed(claims.take(PR, "push"));
    claim.release();
    claim.release();
    expect(claims.holder(PR)).toBeNull();
    expect(typeof claims.take(PR, "chat-turn")).toBe("object");
  });

  it("keeps holding across a long turn while it makes progress", () => {
    const clock = fakeClock();
    const claims = createWorkspaceClaims(IDLE_MS, clock.now);
    const claim = claimed(claims.take(PR, "chat-turn"));
    for (let i = 0; i < 12; i++) {
      clock.advance(10 * 60 * 1000);
      claim.touch();
      expect(claims.holder(PR)).toBe("chat-turn");
    }
  });

  it("expires a claim that went silent past the idle deadline", () => {
    const clock = fakeClock();
    const claims = createWorkspaceClaims(IDLE_MS, clock.now);
    claimed(claims.take(PR, "chat-turn"));
    clock.advance(IDLE_MS - 1);
    expect(claims.holder(PR)).toBe("chat-turn");
    clock.advance(1);
    expect(claims.holder(PR)).toBeNull();
  });

  it("never lets a stale holder's release drop the next holder's claim", () => {
    const clock = fakeClock();
    const claims = createWorkspaceClaims(IDLE_MS, clock.now);
    const leaked = claimed(claims.take(PR, "chat-turn"));
    clock.advance(IDLE_MS + 1);
    claimed(claims.take(PR, "push"));

    leaked.release();
    leaked.touch();
    expect(claims.holder(PR)).toBe("push");
  });

  it("claims per PR", () => {
    const claims = createWorkspaceClaims(IDLE_MS, fakeClock().now);
    claimed(claims.take(PR, "chat-turn"));
    expect(typeof claims.take("repo-uuid:1234", "push")).toBe("object");
  });
});
