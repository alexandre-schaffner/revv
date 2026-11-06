// ── Walkthrough status transitions ───────────────────────────────────────────
// Every write of `walkthroughs.status` after a row is created, and the event
// announcing it after the commit (invariants 8 and 11). WalkthroughJobs is the
// only caller.

import type {
  WalkthroughEndReason,
  WalkthroughMode,
  WalkthroughStreamEvent,
  WalkthroughTokenUsage,
} from "@revv/shared";
import type { Context } from "effect";
import { Effect } from "effect";
import type { Db } from "../../db";
import type { DbError } from "../../domain/errors";
import { withDb } from "../../effects/with-db";
import type { RemoteWalkthroughCache } from "../RemoteWalkthroughCache";
import type { WalkthroughService } from "../Walkthrough";

/** Why a run ended without completing, and what the user is told. */
export interface WalkthroughFailure {
  readonly reason: WalkthroughEndReason;
  readonly message: string;
}

/** `errorMessage` of a row the user stopped. */
export const WALKTHROUGH_CANCELLED_MESSAGE = "Walkthrough cancelled";

export const CANCELLED: WalkthroughFailure = {
  reason: "cancelled",
  message: WALKTHROUGH_CANCELLED_MESSAGE,
};

export interface WalkthroughLifecycle {
  /**
   * `generating` → `complete`. A generated review goes to the team cache; an
   * imported one (`source`) announces where it came from instead.
   */
  readonly complete: (
    walkthroughId: string,
    tokenUsage: WalkthroughTokenUsage,
    source?: "remote" | "restack",
  ) => Effect.Effect<void, DbError>;
  /** `generating` → `error`, with why. */
  readonly fail: (
    walkthroughId: string,
    failure: WalkthroughFailure,
  ) => Effect.Effect<void, DbError>;
  /**
   * Supersede a PR's rows (in `mode`, or every perspective), except those at
   * `exceptHeadSha`: a run already at a head the caller just saw isn't stale.
   */
  readonly supersede: (
    prId: string,
    exceptHeadSha?: string,
    mode?: WalkthroughMode,
  ) => Effect.Effect<void, DbError>;
}

export function makeWalkthroughLifecycle(deps: {
  readonly db: Db;
  readonly walkthroughs: Context.Service.Shape<typeof WalkthroughService>;
  readonly remoteCache: Context.Service.Shape<typeof RemoteWalkthroughCache>;
  readonly emit: (walkthroughId: string, event: WalkthroughStreamEvent) => Effect.Effect<unknown>;
}): WalkthroughLifecycle {
  const { db } = deps;

  const complete = (
    walkthroughId: string,
    tokenUsage: WalkthroughTokenUsage,
    source?: "remote" | "restack",
  ): Effect.Effect<void, DbError> =>
    Effect.gen(function* () {
      const moved = yield* withDb(
        db,
        deps.walkthroughs.finish(walkthroughId, "complete", { tokenUsage }),
      );
      if (!moved) return;
      if (source !== undefined) {
        yield* deps.emit(walkthroughId, {
          type: "lifecycle:cache-hit",
          data: { walkthroughId, source },
        });
      } else {
        // Shared with the team in the background (the cache shares only the
        // reviewer perspective); a failed push never touches the completion
        // (invariant 8).
        yield* Effect.forkDetach(deps.remoteCache.push(walkthroughId));
      }
      yield* deps.emit(walkthroughId, {
        type: "lifecycle:complete",
        data: { walkthroughId, tokenUsage },
      });
    });

  const fail = (walkthroughId: string, failure: WalkthroughFailure): Effect.Effect<void, DbError> =>
    Effect.gen(function* () {
      const moved = yield* withDb(
        db,
        deps.walkthroughs.finish(walkthroughId, "error", {
          errorMessage: failure.message,
          endReason: failure.reason,
        }),
      );
      if (!moved) return;
      yield* deps.emit(walkthroughId, {
        type: "lifecycle:error",
        data: { reason: failure.reason, message: failure.message },
      });
    });

  const supersede = (
    prId: string,
    exceptHeadSha?: string,
    mode?: WalkthroughMode,
  ): Effect.Effect<void, DbError> =>
    Effect.gen(function* () {
      const ids = yield* withDb(db, deps.walkthroughs.supersedeAllForPr(prId, exceptHeadSha, mode));
      for (const walkthroughId of ids) {
        yield* deps.emit(walkthroughId, {
          type: "lifecycle:superseded",
          data: { walkthroughId, supersededBy: null },
        });
      }
    });

  return { complete, fail, supersede };
}
