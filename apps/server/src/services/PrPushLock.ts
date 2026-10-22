// ── PrPushLockService ──────────────────────────────────────────────────────
//
// One push to a PR's source branch at a time. Two flows push there: the chat
// panel's "Push proposed commits" (`ChatChangesPush`) and the Conversation
// tab's "Resolve with agent" base sync (`BaseConflicts`). Each run leases the
// remote head it read, so overlapping runs couldn't corrupt the branch, but
// the second would fail late, after an agent run, on a lease the first one
// moved. The lock makes it fail up front instead.
//
// In-memory on purpose: it guards a process-local critical section (a push
// in flight). After a crash there is nothing to resume, so nothing needs to
// persist.

import { Context, Effect, Layer } from "effect";
import { ConcurrentPushError } from "../domain/errors";

export type PushHolder = "chat-push" | "base-sync";

export class PrPushLockService extends Context.Service<
  PrPushLockService,
  {
    /** Claim the PR, or fail with `ConcurrentPushError` when someone else holds it. */
    readonly acquire: (
      prId: string,
      holder: PushHolder,
    ) => Effect.Effect<void, ConcurrentPushError>;
    readonly release: (prId: string) => Effect.Effect<void>;
    readonly holder: (prId: string) => PushHolder | null;
  }
>()("PrPushLockService") {}

export const PrPushLockServiceLive = Layer.sync(PrPushLockService, () => {
  const held = new Map<string, PushHolder>();
  return {
    acquire: (prId, holder) =>
      Effect.suspend(() => {
        if (held.has(prId)) return Effect.fail(new ConcurrentPushError({ prId }));
        held.set(prId, holder);
        return Effect.void;
      }),
    release: (prId) =>
      Effect.sync(() => {
        held.delete(prId);
      }),
    holder: (prId) => held.get(prId) ?? null,
  };
});
