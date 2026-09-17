import { describe, expect, it } from "bun:test";
import { createChatStreamLeases } from "./chat-stream-leases";

// The regression: a chat turn claimed the PR's worktree, its stream never ran
// the cleanup that gave the claim back, and every push for that PR was refused
// with "Wait for the chat agent to finish before pushing" until the server was
// restarted — hours after the agent had stopped. The claim expires now, so a
// missed release costs one idle window rather than the process's lifetime.

const IDLE_MS = 15 * 60 * 1000;
const PR = "repo-uuid:2945";

/** A clock the test moves by hand. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createChatStreamLeases", () => {
  it("holds the worktree for a turn that is streaming", () => {
    const clock = fakeClock();
    const leases = createChatStreamLeases(IDLE_MS, clock.now);

    expect(leases.isLive(PR)).toBe(false);
    leases.begin(PR);
    expect(leases.isLive(PR)).toBe(true);
  });

  it("gives the worktree back on release", () => {
    const clock = fakeClock();
    const leases = createChatStreamLeases(IDLE_MS, clock.now);

    const lease = leases.begin(PR);
    lease.release();

    expect(leases.isLive(PR)).toBe(false);
    // Idempotent — every exit path may call it.
    expect(() => {
      lease.release();
    }).not.toThrow();
    expect(leases.isLive(PR)).toBe(false);
  });

  it("keeps holding across a long turn, as long as frames keep arriving", () => {
    const clock = fakeClock();
    const leases = createChatStreamLeases(IDLE_MS, clock.now);
    const lease = leases.begin(PR);

    // A two-hour turn that emits something every 10 minutes — a test suite
    // shelling out, then a tool result — never loses its claim.
    for (let i = 0; i < 12; i++) {
      clock.advance(10 * 60 * 1000);
      lease.touch();
      expect(leases.isLive(PR)).toBe(true);
    }
  });

  it("expires a lease whose turn went silent past the idle deadline", () => {
    const clock = fakeClock();
    const leases = createChatStreamLeases(IDLE_MS, clock.now);
    leases.begin(PR);

    clock.advance(IDLE_MS - 1);
    expect(leases.isLive(PR)).toBe(true);

    clock.advance(1);
    expect(leases.isLive(PR)).toBe(false);
  });

  it("expires per PR, so one leaked turn can't block another PR", () => {
    const clock = fakeClock();
    const leases = createChatStreamLeases(IDLE_MS, clock.now);
    const other = "repo-uuid:1234";

    leases.begin(PR);
    clock.advance(IDLE_MS + 1);
    const liveLease = leases.begin(other);

    expect(leases.isLive(PR)).toBe(false);
    expect(leases.isLive(other)).toBe(true);
    liveLease.release();
  });

  it("re-claims cleanly after an expiry — a later turn on the same PR holds again", () => {
    const clock = fakeClock();
    const leases = createChatStreamLeases(IDLE_MS, clock.now);

    leases.begin(PR);
    clock.advance(IDLE_MS + 1);
    expect(leases.isLive(PR)).toBe(false);

    leases.begin(PR);
    expect(leases.isLive(PR)).toBe(true);
  });
});
