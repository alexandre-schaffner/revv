// Who the signed-in user is on a PR: the PR's owning account's own GitHub
// login (`GitHubAccounts.viewerLogin`), never the request's or the user's.

import { type AuthorRole, REVIEW_MODE, type ReviewMode, reviewModeFor } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Db } from "../db";
import { account, pullRequests, repositories, user } from "../db/schema";
import type { DbError } from "../domain/errors";
import { dbTry } from "../effects/db-try";
import { DbService } from "./Db";

export interface PrViewer {
  /** The owning account's login, or null when unknown. */
  readonly login: string | null;
  /** The local user's display name. */
  readonly name: string | null;
  readonly prAuthorLogin: string | null;
}

/** {@link viewerOnPr}, for a caller already inside a DB read. Throws on a DB failure. */
export function readViewerOnPr(db: Db, prId: string): PrViewer {
  const row = db
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
    .get();
  return {
    login: row?.login ?? null,
    name: row?.name ?? null,
    prAuthorLogin: row?.prAuthorLogin ?? null,
  };
}

export const viewerOnPr = (prId: string): Effect.Effect<PrViewer, DbError, DbService> =>
  Effect.flatMap(DbService, ({ db }) =>
    dbTry(`read the viewer on ${prId}`, () => readViewerOnPr(db, prId)),
  );

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
 * it picks the default walkthrough perspective. A missing row or an unknown
 * login answers `reviewer`. Throws on a DB failure.
 */
export function reviewModeOnPr(db: Db, prId: string): ReviewMode {
  const viewer = readViewerOnPr(db, prId);
  return reviewModeFor(viewer.prAuthorLogin, viewer.login);
}
