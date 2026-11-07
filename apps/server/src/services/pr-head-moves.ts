// A pull request's head moved, as `PrMirror` recorded it. The mirror is the
// one writer of PR rows and sits below the features that react to a head move
// (WalkthroughJobs supersedes the reviews pinned to the old head, invariant
// 7), so it publishes here instead of depending on them. One instance per app.
//
// Listeners run on their own fibers, never the publisher's: a `mirror.apply`
// caller (the poll, a refresh, a push, a walkthrough request holding its PR
// lock) never waits on what a listener waits for.

import { Context, Effect, Layer } from "effect";

type HeadMoveListener = (prId: string, headSha: string) => Effect.Effect<void>;

export class PrHeadMoves extends Context.Service<
  PrHeadMoves,
  {
    /**
     * Start every listener for a trusted head move, after its row committed,
     * and return without waiting for them. A listener may run after a later
     * move of the same PR has committed.
     */
    readonly publish: (prId: string, headSha: string) => Effect.Effect<void>;
    /** Hear every head move from now on. A listener's failures are its own. */
    readonly listen: (listener: HeadMoveListener) => Effect.Effect<void>;
  }
>()("PrHeadMoves") {}

export const PrHeadMovesLive = Layer.effect(
  PrHeadMoves,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const listeners: HeadMoveListener[] = [];
    return {
      publish: (prId, headSha) =>
        Effect.forEach(listeners, (listener) => Effect.forkIn(listener(prId, headSha), scope), {
          discard: true,
        }),
      listen: (listener) => Effect.sync(() => void listeners.push(listener)),
    };
  }),
);
