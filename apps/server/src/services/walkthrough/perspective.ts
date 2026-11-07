import type { WalkthroughMode } from "@revv/shared";
import { desc, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Db } from "../../db";
import { walkthroughs } from "../../db/schema/walkthroughs";
import type { DbError } from "../../domain/errors";
import { dbTry } from "../../effects/db-try";
import { DbService } from "../Db";
import { reviewModeOnPr } from "../review-mode";

/**
 * The perspective a PR's walkthrough is shown and requested in when the
 * caller names none: the newest walkthrough's — the user's last pick, kept
 * through a supersede — else the identity-derived one. Asking in the other
 * perspective would retire the one the user chose; only one is active per PR.
 * Throws on a DB failure.
 */
export function perspectiveOf(db: Db, prId: string): WalkthroughMode {
  const latest = db
    .select({ mode: walkthroughs.mode })
    .from(walkthroughs)
    .where(eq(walkthroughs.pullRequestId, prId))
    .orderBy(desc(walkthroughs.generatedAt))
    .get();
  return latest?.mode ?? reviewModeOnPr(db, prId);
}

export const walkthroughPerspective = (
  prId: string,
): Effect.Effect<WalkthroughMode, DbError, DbService> =>
  Effect.flatMap(DbService, ({ db }) =>
    dbTry(`read the perspective of ${prId}`, () => perspectiveOf(db, prId)),
  );
