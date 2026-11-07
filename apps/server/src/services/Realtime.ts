// Who receives a server push. Features address an event to an account, or to
// the repository or pull request it concerns, and this resolves the local
// user who owns it in one place: every client of that user hears it, whichever
// host it has active. `Broadcaster` only moves the bytes.
//
// Commit first, broadcast second (invariant 8): callers send after their
// write commits. A push is best-effort, so nothing here fails: an owner that
// can't be resolved is logged and the push dropped. Clients that miss one
// reconcile from the REST snapshots.

import type { ServerEventMessage } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { account, pullRequests, repositories } from "../db/schema";
import { dbTry } from "../effects/db-try";
import { logError } from "../logger";
import { Broadcaster } from "./Broadcaster";
import { DbService } from "./Db";

export class Realtime extends Context.Service<
  Realtime,
  {
    readonly toAccount: (accountId: string, msg: ServerEventMessage) => Effect.Effect<void>;
    readonly toRepo: (repoId: string, msg: ServerEventMessage) => Effect.Effect<void>;
    readonly toPr: (prId: string, msg: ServerEventMessage) => Effect.Effect<void>;
  }
>()("Realtime") {}

export const RealtimeLive = Layer.effect(
  Realtime,
  Effect.gen(function* () {
    const broadcaster = yield* Broadcaster;
    const { db } = yield* DbService;

    const toOwner = (
      label: string,
      owner: () => { userId: string } | undefined,
      msg: ServerEventMessage,
    ) =>
      dbTry(`resolve the owner of ${label}`, owner).pipe(
        Effect.flatMap((row) =>
          row
            ? broadcaster.broadcastToUser(row.userId, msg)
            : Effect.sync(() => logError("realtime", `${msg.type}: ${label} has no owner`)),
        ),
        Effect.catch((e) => Effect.sync(() => logError("realtime", `${msg.type}:`, e.message))),
      );

    return {
      toAccount: (accountId, msg) =>
        toOwner(
          `account ${accountId}`,
          () =>
            db
              .select({ userId: account.userId })
              .from(account)
              .where(eq(account.id, accountId))
              .get(),
          msg,
        ),
      toRepo: (repoId, msg) =>
        toOwner(
          `repository ${repoId}`,
          () =>
            db
              .select({ userId: account.userId })
              .from(repositories)
              .innerJoin(account, eq(account.id, repositories.accountId))
              .where(eq(repositories.id, repoId))
              .get(),
          msg,
        ),
      toPr: (prId, msg) =>
        toOwner(
          `pull request ${prId}`,
          () =>
            db
              .select({ userId: account.userId })
              .from(pullRequests)
              .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
              .innerJoin(account, eq(account.id, repositories.accountId))
              .where(eq(pullRequests.id, prId))
              .get(),
          msg,
        ),
    };
  }),
);
