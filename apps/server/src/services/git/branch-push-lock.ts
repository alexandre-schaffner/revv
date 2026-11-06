// ── BranchPushLock ─────────────────────────────────────────────────────────
//
// One push to a remote branch at a time. Every flow that pushes a PR's head
// branch takes it before doing any work: the chat push, the base sync, and the
// stack rebase (which a stack merge runs too). Each of them leases the tip it
// read, so overlapping runs couldn't corrupt the branch, but the second would
// fail late, after an agent run or a replay, on a lease the first one moved.
// The lock makes it fail up front instead.
//
// In-memory on purpose: it guards a push in flight in this process, and
// nothing about a push survives a restart.

import { Context, Effect, Layer, type Scope } from "effect";
import { ConcurrentPushError } from "../../domain/errors";

export type PushHolder = "chat-push" | "base-sync" | "stack-rebase";

export interface PushTarget {
  readonly repoId: string;
  readonly branch: string;
}

export class BranchPushLock extends Context.Service<
  BranchPushLock,
  {
    /**
     * Hold every branch in `targets` until the scope closes, or fail with
     * `ConcurrentPushError` naming the first one already held, taking none.
     */
    readonly hold: (
      targets: readonly PushTarget[],
      holder: PushHolder,
    ) => Effect.Effect<void, ConcurrentPushError, Scope.Scope>;
    readonly holder: (target: PushTarget) => PushHolder | null;
  }
>()("BranchPushLock") {}

const keyOf = ({ repoId, branch }: PushTarget) => `${repoId}\0${branch}`;

export const BranchPushLockLive = Layer.sync(BranchPushLock, () => {
  const held = new Map<string, PushHolder>();
  return {
    hold: (targets, holder) =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          const taken = targets.find((t) => held.has(keyOf(t)));
          if (taken) {
            return Effect.fail(
              new ConcurrentPushError({
                branch: taken.branch,
                heldBy: held.get(keyOf(taken)) ?? holder,
              }),
            );
          }
          const keys = [...new Set(targets.map(keyOf))];
          for (const key of keys) held.set(key, holder);
          return Effect.succeed(keys);
        }),
        (keys) =>
          Effect.sync(() => {
            for (const key of keys) held.delete(key);
          }),
      ).pipe(Effect.asVoid),
    holder: (target) => held.get(keyOf(target)) ?? null,
  };
});
