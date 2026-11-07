// Who the signed-in user is on a PR: the PR's owning account's own GitHub
// login (`GitHubAccounts.viewerLogin`), never the request's or the user's.

import { type AuthorRole, REVIEW_MODE, type ReviewMode, reviewModeFor } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { account, pullRequests, repositories, user } from "../db/schema";
import type { DbError } from "../domain/errors";
import { dbTry } from "../effects/db-try";
import { logError } from "../logger";
import { DbService } from "./Db";

export interface PrViewer {
  /** The owning account's login, or null when unknown. */
  readonly login: string | null;
  /** The local user's display name. */
  readonly name: string | null;
  readonly prAuthorLogin: string | null;
}

export const viewerOnPr = (prId: string): Effect.Effect<PrViewer, DbError, DbService> =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const row = yield* dbTry(`read the viewer on ${prId}`, () =>
      db
        .select({
          login: account.githubLogin,
          name: user.name,
          prAuthorLogin: pullRequests.authorLogin,
        })
        .from(pullRequests)
        .leftJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
        .leftJoin(account, eq(account.id, repositories.accountId))
        .leftJoin(user, eq(user.id, account.userId))
        .where(eq(pullRequests.id, prId))
        .get(),
    );
    return {
      login: row?.login ?? null,
      name: row?.name ?? null,
      prAuthorLogin: row?.prAuthorLogin ?? null,
    };
  });

/** The authorship of a message the signed-in user writes on the PR: the PR's author is its `coder`. */
export function humanAuthor(viewer: PrViewer): {
  readonly authorRole: AuthorRole;
  readonly authorName: string;
  readonly authorLogin?: string;
} {
  const role = reviewModeFor(viewer.prAuthorLogin, viewer.login);
  return {
    authorRole: role === REVIEW_MODE.author ? "coder" : "reviewer",
    authorName: viewer.login ?? viewer.name ?? "You",
    ...(viewer.login ? { authorLogin: viewer.login } : {}),
  };
}

/**
 * The signed-in user's lens on a PR, for code with no request to read it from:
 * it picks the default walkthrough perspective. A missing row, an unknown login
 * or a DB failure answers `reviewer`.
 */
export const resolveReviewModeForPr = (prId: string): Effect.Effect<ReviewMode, never, DbService> =>
  viewerOnPr(prId).pipe(
    Effect.map((viewer) => reviewModeFor(viewer.prAuthorLogin, viewer.login)),
    Effect.catch((cause) =>
      Effect.sync(() => {
        logError("review-mode", `falling back to 'reviewer' for ${prId}:`, cause);
        return REVIEW_MODE.reviewer;
      }),
    ),
  );
