import type { WalkthroughSnapshotV2, WalkthroughStreamEvent } from "@revv/shared";
import { Effect, Option } from "effect";
import { ZERO_TOKEN_USAGE } from "../ai/agent-stream/token-usage";
import type { Db } from "../db/index";
import { type DbError, ImportError } from "../domain/errors";
import { debug, logError } from "../logger";
import { exportWalkthroughSnapshot } from "./walkthrough-snapshot";

/**
 * Import a cache hit and emit the same lifecycle boundary as agent completion.
 */
export function tryImportCachedWalkthrough(input: {
  readonly enabled: boolean;
  readonly source?: "remote" | "restack";
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
  const source = input.source ?? "remote";

  return Effect.gen(function* () {
    const snapshot = yield* input.fetchSnapshot;
    if (Option.isNone(snapshot)) return false;

    const imported = yield* input.importSnapshot(snapshot.value).pipe(Effect.result);
    if (imported._tag === "Failure") {
      logError(
        "walkthrough-jobs",
        `${source} import failed wt=${input.walkthroughId} — falling through to agent: ${imported.failure.reason}`,
      );
      return false;
    }

    yield* input.markComplete;
    yield* input
      .emitEvent({
        type: "lifecycle:cache-hit",
        data: { walkthroughId: input.walkthroughId, source },
      })
      .pipe(Effect.catch(() => Effect.void));
    yield* input
      .emitEvent({
        type: "lifecycle:complete",
        data: { walkthroughId: input.walkthroughId, tokenUsage: ZERO_TOKEN_USAGE },
      })
      .pipe(Effect.catch(() => Effect.void));
    debug(
      "walkthrough-jobs",
      `${source} hit wt=${input.walkthroughId} pr=${input.prId} sha=${input.headSha} — skipping agent`,
    );
    return true;
  });
}

export function tryCarryRestackedWalkthrough(input: {
  readonly db: Db;
  readonly fromWalkthroughId: string;
  readonly walkthroughId: string;
  readonly prId: string;
  readonly repoFullName: string;
  readonly headSha: string;
  readonly importSnapshot: (snapshot: WalkthroughSnapshotV2) => Effect.Effect<void, ImportError>;
  readonly markCarriedFrom: Effect.Effect<void, DbError>;
  readonly markComplete: Effect.Effect<void>;
  readonly emitEvent: (event: WalkthroughStreamEvent) => Effect.Effect<unknown>;
}): Effect.Effect<boolean> {
  const { db, fromWalkthroughId, repoFullName, importSnapshot, markCarriedFrom, ...rest } = input;
  return tryImportCachedWalkthrough({
    ...rest,
    enabled: true,
    source: "restack",
    repoFullName,
    importSnapshot: (snapshot) =>
      importSnapshot(snapshot).pipe(
        Effect.zipRight(
          markCarriedFrom.pipe(
            Effect.mapError(
              (e) =>
                new ImportError({
                  walkthroughId: input.walkthroughId,
                  reason: e.message,
                  cause: e,
                }),
            ),
          ),
        ),
      ),
    fetchSnapshot: Effect.try({
      try: () =>
        Option.some(
          exportWalkthroughSnapshot(db, { walkthroughId: fromWalkthroughId, repoFullName }),
        ),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          logError(
            "walkthrough-jobs",
            `restack export of ${fromWalkthroughId} failed — falling through to agent:`,
            cause,
          );
          return Option.none<WalkthroughSnapshotV2>();
        }),
      ),
    ),
  });
}
