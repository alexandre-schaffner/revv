import type { WalkthroughSnapshotV2, WalkthroughStreamEvent } from "@revv/shared";
import { Effect, Option } from "effect";
import { ZERO_TOKEN_USAGE } from "../ai/agent-stream/token-usage";
import type { ImportError } from "../domain/errors";
import { debug, logError } from "../logger";

/** Import a cache hit and emit the same lifecycle boundary as agent completion. */
export function tryImportCachedWalkthrough(input: {
  readonly enabled: boolean;
  readonly walkthroughId: string;
  readonly prId: string;
  readonly repoFullName: string;
  readonly headSha: string;
  readonly fetchSnapshot: Effect.Effect<Option.Option<WalkthroughSnapshotV2>>;
  readonly importSnapshot: (snapshot: WalkthroughSnapshotV2) => Effect.Effect<void, ImportError>;
  readonly markComplete: Effect.Effect<void>;
  readonly emitEvent: (event: WalkthroughStreamEvent) => Effect.Effect<unknown>;
}): Effect.Effect<boolean> {
  if (!input.enabled) return Effect.succeed(false);

  return Effect.gen(function* () {
    const snapshot = yield* input.fetchSnapshot;
    if (Option.isNone(snapshot)) return false;

    const imported = yield* input.importSnapshot(snapshot.value).pipe(Effect.either);
    if (imported._tag === "Left") {
      logError(
        "walkthrough-jobs",
        `cache import failed wt=${input.walkthroughId} — falling through to agent: ${imported.left.reason}`,
      );
      return false;
    }

    yield* input.markComplete;
    yield* input
      .emitEvent({
        type: "lifecycle:cache-hit",
        data: { walkthroughId: input.walkthroughId, source: "remote" },
      })
      .pipe(Effect.catchAll(() => Effect.void));
    yield* input
      .emitEvent({
        type: "lifecycle:complete",
        data: { walkthroughId: input.walkthroughId, tokenUsage: ZERO_TOKEN_USAGE },
      })
      .pipe(Effect.catchAll(() => Effect.void));
    debug(
      "walkthrough-jobs",
      `cache hit wt=${input.walkthroughId} pr=${input.prId} sha=${input.headSha} — skipping agent`,
    );
    return true;
  });
}
