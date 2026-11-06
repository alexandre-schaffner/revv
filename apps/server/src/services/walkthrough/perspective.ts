import type { WalkthroughMode } from "@revv/shared";
import { Effect } from "effect";
import type { DbError } from "../../domain/errors";
import type { DbService } from "../Db";
import { resolveReviewModeForPr } from "../review-mode";
import { WalkthroughService } from "../Walkthrough";

/**
 * The perspective a PR's walkthrough is shown and requested in when the
 * caller names none: the newest walkthrough's — the user's last pick, kept
 * through a supersede — else the identity-derived one. Asking in the other
 * perspective would retire the one the user chose; only one is active per PR.
 */
export const walkthroughPerspective = (
  prId: string,
): Effect.Effect<WalkthroughMode, DbError, WalkthroughService | DbService> =>
  Effect.gen(function* () {
    const service = yield* WalkthroughService;
    return (yield* service.getLatestMode(prId)) ?? (yield* resolveReviewModeForPr(prId)).mode;
  });
