// A pull request's head moved, as `PrMirror` recorded it. The mirror is the
// one writer of PR rows and sits below the features that react to a head move
// (WalkthroughJobs supersedes the reviews pinned to the old head, invariant
// 7), so it publishes here instead of depending on them. One instance per app.

import { Context, Effect, Layer } from "effect";

type HeadMoveListener = (prId: string, headSha: string) => Effect.Effect<void>;

export class PrHeadMoves extends Context.Service<
  PrHeadMoves,
  {
    /** Run every listener for a trusted head move, after its row committed. */
    readonly publish: (prId: string, headSha: string) => Effect.Effect<void>;
    /** Hear every head move from now on. A listener's failures are its own. */
    readonly listen: (listener: HeadMoveListener) => Effect.Effect<void>;
  }
>()("PrHeadMoves") {}

export const PrHeadMovesLive = Layer.sync(PrHeadMoves, () => {
  const listeners: HeadMoveListener[] = [];
  return {
    publish: (prId, headSha) =>
      Effect.forEach(listeners, (listener) => listener(prId, headSha), { discard: true }),
    listen: (listener) => Effect.sync(() => void listeners.push(listener)),
  };
});
