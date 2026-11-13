// The PRs a user pinned, oldest first. A pin is a (user, PR) pair; its time
// only orders the list.

import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { pinnedPullRequests } from "../db/schema";
import { dbTry } from "../effects/db-try";
import { DbService } from "./Db";

export const listPinned = (userId: string) =>
  Effect.flatMap(DbService, ({ db }) =>
    dbTry("list pinned PRs", () =>
      db
        .select({ prId: pinnedPullRequests.prId })
        .from(pinnedPullRequests)
        .where(eq(pinnedPullRequests.userId, userId))
        // `created_at` has second precision: pins within one second keep insertion order.
        .orderBy(pinnedPullRequests.createdAt, sql`rowid`)
        .all()
        .map((r) => r.prId),
    ),
  );

/** Pinning a PR the user already pinned keeps the first pin. */
export const pinPr = (userId: string, prId: string) =>
  Effect.flatMap(DbService, ({ db }) =>
    dbTry("pin PR", () =>
      db.insert(pinnedPullRequests).values({ userId, prId }).onConflictDoNothing().run(),
    ),
  ).pipe(Effect.asVoid);

export const unpinPr = (userId: string, prId: string) =>
  Effect.flatMap(DbService, ({ db }) =>
    dbTry("unpin PR", () =>
      db
        .delete(pinnedPullRequests)
        .where(and(eq(pinnedPullRequests.userId, userId), eq(pinnedPullRequests.prId, prId)))
        .run(),
    ),
  ).pipe(Effect.asVoid);
