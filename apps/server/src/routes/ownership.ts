// Several local users can share one Revv install, each with their own GitHub
// accounts. A router registers `ownedBy` (or `asOwner`) once, right after its
// auth plugin, and every route it then declares answers 404, before its
// handler runs, for an id that names something in another user's repository.
//
// A request about a repository acts as the account that owns it, whichever
// host the user has active: `asOwner` hands the route that account.

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
import { dbTry } from "../effects/db-try";
import { AppRuntime } from "../runtime";
import { DbService } from "../services/Db";
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
 * Resolves the account owning the first one carried, or null when it carries
 * none.
 */
export const checkOwnership = (fields: Fields, request: GuardedRequest, userId: string) =>
  Effect.flatMap(DbService, ({ db }) =>
    dbTry("check ownership", () => {
      const body = typeof request.body === "object" && request.body !== null ? request.body : {};
      let owner: string | null = null;
      for (const [field, kind] of Object.entries(fields)) {
        const id = request.params[field] ?? (body as Record<string, unknown>)[field];
        if (typeof id !== "string") continue;
        const repositoryId = OWNING_REPOSITORY[kind](db, id);
        const row =
          repositoryId === undefined
            ? undefined
            : db
                .select({ accountId: repositories.accountId })
                .from(repositories)
                .innerJoin(account, eq(account.id, repositories.accountId))
                .where(and(eq(repositories.id, repositoryId), eq(account.userId, userId)))
                .get();
        if (row === undefined) return new NotFoundError({ resource: kind, id });
        owner ??= row.accountId;
      }
      return owner;
    }),
  ).pipe(
    Effect.flatMap((owner) =>
      owner instanceof NotFoundError ? Effect.fail(owner) : Effect.succeed(owner),
    ),
  );

/** {@link checkOwnership} as a router's `beforeHandle` hook, for the signed-in user. */
export function ownedBy(fields: Fields) {
  return async (ctx: GuardedRequest & { readonly userId: string }) => {
    const exit = await AppRuntime.runPromiseExit(checkOwnership(fields, ctx, ctx.userId));
    return Exit.isFailure(exit) ? errorResponse(Cause.squash(exit.cause)) : undefined;
  };
}

/**
 * {@link checkOwnership} as a router's `resolve` hook: derives `owner`, the
 * account the route acts as. Every route of the router carries one of
 * `fields`.
 */
export function asOwner(fields: Fields) {
  const [field, kind] = Object.entries(fields)[0] ?? [];
  return async (ctx: GuardedRequest & { readonly userId: string }) => {
    const exit = await AppRuntime.runPromiseExit(
      checkOwnership(fields, ctx, ctx.userId).pipe(
        Effect.flatMap((owner) =>
          owner === null
            ? Effect.fail(new NotFoundError({ resource: kind ?? "resource", id: field ?? "" }))
            : Effect.succeed({ owner }),
        ),
      ),
    );
    return Exit.isSuccess(exit) ? exit.value : errorResponse(Cause.squash(exit.cause));
  };
}
