// The signed-in user's lens on a PR (`reviewModeFor`), for code with no
// request to read it from. It picks the default walkthrough perspective; a
// PR's comment threads don't depend on it.
//
// The viewer's login is read from `user.githubLogin`, the column `GET
// /api/user` serves and the web's `getCurrentUserLogin()` reads, so this
// answers what the web shows. `account.githubLogin` can hold a different login
// for the same person on GitHub Enterprise.

import { REVIEW_MODE, type ReviewMode, reviewModeFor } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { account, pullRequests, repositories, user } from "../db/schema";
import { dbTry } from "../effects/db-try";
import { logError } from "../logger";
import { DbService } from "./Db";

/** A missing row, an unknown login or a DB failure answers `reviewer`, as the web does. */
export const resolveReviewModeForPr = (prId: string): Effect.Effect<ReviewMode, never, DbService> =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    // `user` is unique on email only, so walk the PR's own repository to its
    // owning account's user rather than reading "the first user".
    const row = yield* dbTry(`resolveReviewModeForPr(${prId})`, () =>
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
    );
    return reviewModeFor(row?.authorLogin, row?.viewerLogin);
  }).pipe(
    Effect.catch((cause) =>
      Effect.sync(() => {
        logError("review-mode", `falling back to 'reviewer' for ${prId}:`, cause);
        return REVIEW_MODE.reviewer;
      }),
    ),
  );
