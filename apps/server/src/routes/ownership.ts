// Several local users can share one Revv install, each with their own GitHub
// accounts. A router registers `ownedBy` once, right after its auth plugin,
// and every route it then declares answers 404, before its handler runs, for
// an id that names something in another user's repository.

import { and, eq } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";
import type { Db } from "../db/index";
import {
  account,
  commentThreads,
  projectRecaps,
  pullRequests,
  repositories,
  reviewSessions,
  stackMergeRuns,
} from "../db/schema";
import { NotFoundError } from "../domain/errors";
import { tryDb } from "../effects/db-try";
import { AppRuntime } from "../runtime";
import { errorResponse } from "./middleware";

/** What a guarded field names. Each resolves to the repository that owns it. */
const OWNING_REPOSITORY = {
  repository: (_db: Db, id: string) => id,
  "pull request": (db: Db, id: string) =>
    db
      .select({ repositoryId: pullRequests.repositoryId })
      .from(pullRequests)
      .where(eq(pullRequests.id, id))
      .get()?.repositoryId,
  thread: (db: Db, id: string) =>
    db
      .select({ repositoryId: pullRequests.repositoryId })
      .from(commentThreads)
      .innerJoin(reviewSessions, eq(reviewSessions.id, commentThreads.reviewSessionId))
      .innerJoin(pullRequests, eq(pullRequests.id, reviewSessions.pullRequestId))
      .where(eq(commentThreads.id, id))
      .get()?.repositoryId,
  recap: (db: Db, id: string) =>
    db
      .select({ repositoryId: projectRecaps.repositoryId })
      .from(projectRecaps)
      .where(eq(projectRecaps.id, id))
      .get()?.repositoryId,
  "stack merge": (db: Db, id: string) =>
    db
      .select({ repositoryId: stackMergeRuns.repositoryId })
      .from(stackMergeRuns)
      .where(eq(stackMergeRuns.id, id))
      .get()?.repositoryId,
} as const;

type Owned = keyof typeof OWNING_REPOSITORY;

type Fields = Readonly<Record<string, Owned>>;

interface GuardedRequest {
  readonly params: Record<string, string | undefined>;
  readonly body: unknown;
}

/**
 * Every field of `fields` the request carries, in its path or its JSON body,
 * names something in one of `userId`'s repositories; else `NotFoundError`.
 */
export const checkOwnership = (fields: Fields, request: GuardedRequest, userId: string) =>
  tryDb("check ownership", (db) => {
    const body = typeof request.body === "object" && request.body !== null ? request.body : {};
    for (const [field, kind] of Object.entries(fields)) {
      const id = request.params[field] ?? (body as Record<string, unknown>)[field];
      if (typeof id !== "string") continue;
      const repositoryId = OWNING_REPOSITORY[kind](db, id);
      const owned =
        repositoryId !== undefined &&
        db
          .select({ id: repositories.id })
          .from(repositories)
          .innerJoin(account, eq(account.id, repositories.accountId))
          .where(and(eq(repositories.id, repositoryId), eq(account.userId, userId)))
          .get() !== undefined;
      if (!owned) return new NotFoundError({ resource: kind, id });
    }
    return null;
  }).pipe(Effect.flatMap((missing) => (missing ? Effect.fail(missing) : Effect.void)));

/** {@link checkOwnership} as a router's `beforeHandle` hook, for the signed-in user. */
export function ownedBy(fields: Fields) {
  return async (ctx: GuardedRequest & { readonly userId: string }) => {
    const exit = await AppRuntime.runPromiseExit(checkOwnership(fields, ctx, ctx.userId));
    return Exit.isFailure(exit) ? errorResponse(Cause.squash(exit.cause)) : undefined;
  };
}
