// ── Review-mode resolution ───────────────────────────────────────────────────
//
// `ReviewMode` is not a user choice: it is derived from identity — `author`
// when the signed-in user created the PR, `reviewer` otherwise. Every UI read
// of a review session carries that answer as `?mode=`.
//
// Background workers have no request to read it from, so they resolve the same
// answer from the DB here. Getting this wrong is not cosmetic: review sessions
// are keyed on `(pullRequestId, mode)`, so a worker that writes into the wrong
// mode's session writes into a session the user's UI never loads.
//
// The comparison itself lives in `@revv/shared` (`reviewModeFor`) and is shared
// verbatim with the web's `getReviewModeForPr`. The inputs have to match too,
// which is why the viewer's login is read from `user.githubLogin` and nowhere
// else: that is the column `GET /api/user` serves and `getCurrentUserLogin()`
// reads. `account.githubLogin` is deliberately NOT consulted — it can hold a
// different login for the same person on GitHub Enterprise, and preferring it
// here would make this resolver disagree with the UI on exactly the installs
// where the disagreement is silent and unrecoverable. If per-repo identity is
// ever wanted, both sides have to move together.

import { REVIEW_MODE, type ReviewMode, reviewModeFor } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { account, pullRequests, repositories, user } from "../db/schema";
import { DbError } from "../domain/errors";
import { logError } from "../logger";
import { DbService } from "./Db";

/**
 * A review-mode verdict plus whether it was actually derived from identity.
 *
 * `resolved: false` means "unknown", not "reviewer". The two are
 * indistinguishable in `mode` because `reviewer` is the safe default for
 * rendering, but they are not interchangeable for callers that *write*: a
 * repair keyed on a guessed mode moves data into a session nothing reads.
 */
export interface ReviewModeVerdict {
  readonly mode: ReviewMode;
  readonly resolved: boolean;
}

const UNRESOLVED: ReviewModeVerdict = { mode: REVIEW_MODE.reviewer, resolved: false };

/**
 * The review mode the UI will be using for this PR.
 *
 * Best-effort by design. A missing row, an unresolved login, or a DB failure
 * all answer `reviewer` — the historical default, the right answer for every
 * PR the user did not write, and the same answer the web gives while identity
 * is still unresolved — but they answer it with `resolved: false`, so a caller
 * can tell a real verdict from a fallback.
 */
export const resolveReviewModeForPr = (
  prId: string,
): Effect.Effect<ReviewModeVerdict, never, DbService> =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    // One keyed join rather than "the first `user` row": `user` is unique on
    // email only, so an install with more than one identity would otherwise
    // resolve against an arbitrary one. Walking the PR's own repository to its
    // owning account to that account's user is deterministic.
    const row = yield* Effect.try({
      try: () =>
        db
          .select({
            authorLogin: pullRequests.authorLogin,
            viewerLogin: user.githubLogin,
          })
          .from(pullRequests)
          .leftJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
          .leftJoin(account, eq(account.id, repositories.accountId))
          .leftJoin(user, eq(user.id, account.userId))
          .where(eq(pullRequests.id, prId))
          .get(),
      catch: (cause) => new DbError({ message: `resolveReviewModeForPr(${prId})`, cause }),
    });
    if (!row?.viewerLogin) return UNRESOLVED;

    return { mode: reviewModeFor(row.authorLogin, row.viewerLogin), resolved: true };
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.sync(() => {
        // Never silent. A swallowed failure here routes synced comments into an
        // invisible session, which is the exact bug `adoptExternalThreads`
        // exists to repair — so the fallback has to leave a trail.
        logError("review-mode", `falling back to 'reviewer' for ${prId}:`, cause);
        return UNRESOLVED;
      }),
    ),
  );
