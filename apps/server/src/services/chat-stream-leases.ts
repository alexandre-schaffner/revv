// ── Chat-turn worktree leases ────────────────────────────────────────────────
//
// A PR's worktree can be written to by exactly one thing at a time: the chat
// agent streaming a turn, or the push flow detaching HEAD and merging the agent
// branch into the source branch. This registry is how the two stay apart.
//
// It is deliberately a *lease* and not a flag. The flag it replaced was set
// when a turn started and cleared from the stream's `finally`, which made that
// one clear a single point of failure — a throw before the stream was wired up,
// a cleanup that failed inside a silent `catch`, an upstream read that never
// settles, and the PR became un-pushable for the life of the server process,
// with no timeout, nothing to inspect, and no way out but a restart. An expiry
// turns "someone forgot to release" from permanent into bounded.
//
// In-memory and per-process on purpose: it coordinates a claim that cannot
// outlive the process holding it. A restart drops every lease, which is
// correct — the streams that held them died with it.

import { logError } from "../logger";

/**
 * A live chat turn's claim on a PR's worktree. The holder re-arms it with
 * {@link touch} as the turn produces output, and drops it with
 * {@link release} on every exit path.
 */
export interface ChatStreamLease {
  /** Re-arm the lease. Called for every frame the turn emits. */
  readonly touch: () => void;
  /** Drop the lease. Idempotent; safe on every exit path. */
  readonly release: () => void;
}

export interface ChatStreamLeaseRegistry {
  /** Claim `prId` for a turn that is about to stream. */
  readonly begin: (prId: string) => ChatStreamLease;
  /** Whether a chat turn still holds `prId`. Drops the lease if it expired. */
  readonly isLive: (prId: string) => boolean;
}

/**
 * Build a lease registry.
 *
 * `idleMs` is the silence a lease survives. Callers pass the agent's own idle
 * deadline: past it the turn has already been killed upstream, so treating the
 * lease as live could only ever be wrong. `now` is injectable for the tests.
 */
export function createChatStreamLeases(
  idleMs: number,
  now: () => number = Date.now,
): ChatStreamLeaseRegistry {
  /** prId → the last time that turn produced a frame. */
  const lastFrameAt = new Map<string, number>();

  return {
    begin: (prId) => {
      lastFrameAt.set(prId, now());
      return {
        touch: () => {
          lastFrameAt.set(prId, now());
        },
        release: () => {
          lastFrameAt.delete(prId);
        },
      };
    },
    isLive: (prId) => {
      const last = lastFrameAt.get(prId);
      if (last === undefined) return false;
      const silentFor = now() - last;
      if (silentFor < idleMs) return true;
      // Expired entries are dropped on read: this is a map of live turns, and
      // a leaked one shouldn't outlive the question that exposed it.
      lastFrameAt.delete(prId);
      logError(
        "chat-push",
        `dropping a chat-stream lease for pr=${prId} that went ${Math.round(silentFor / 1000)}s ` +
          "without a frame — the turn that took it never released it",
      );
      return false;
    },
  };
}
