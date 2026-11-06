// ── Realtime ────────────────────────────────────────────────────────────────
//
// Who receives a server push. Features address an event to an account, or to
// the repository or pull request it concerns, and this resolves the owning
// account in one place; `Broadcaster` only moves the bytes.
//
// Commit first, broadcast second (invariant 8): callers send after their
// write commits. A push is best-effort, so nothing here fails: an owner that
// can't be resolved is logged and the push dropped. Clients that miss one
// reconcile from the REST snapshots.

import type { ServerEventMessage } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { pullRequests, repositories } from "../db/schema";
import { dbTry } from "../effects/db-try";
import { logError } from "../logger";
import { Broadcaster } from "./Broadcaster";
import { DbService } from "./Db";

export class Realtime extends Context.Service<
  Realtime,
  {
    readonly toAccount: (accountId: string, msg: ServerEventMessage) => Effect.Effect<void>;
    /** To the account that tracks the repository. */
    readonly toRepo: (repoId: string, msg: ServerEventMessage) => Effect.Effect<void>;
    /** To the account that tracks the pull request's repository. */
    readonly toPr: (prId: string, msg: ServerEventMessage) => Effect.Effect<void>;
    /** To every client. Only for server-global signals that carry no account data. */
    readonly toAll: (msg: ServerEventMessage) => Effect.Effect<void>;
  }
>()("Realtime") {}

export const RealtimeLive = Layer.effect(
  Realtime,
  Effect.gen(function* () {
    const broadcaster = yield* Broadcaster;
    const { db } = yield* DbService;

    const toOwner = (
      label: string,
      owner: () => { accountId: string } | undefined,
      msg: ServerEventMessage,
    ) =>
      dbTry(`resolve the owner of ${label}`, owner).pipe(
        Effect.flatMap((row) =>
          row
            ? broadcaster.broadcastToAccount(row.accountId, msg)
            : Effect.sync(() => logError("realtime", `${msg.type}: ${label} has no owner`)),
        ),
        Effect.catch((e) => Effect.sync(() => logError("realtime", `${msg.type}:`, e.message))),
      );

    return {
      toAccount: broadcaster.broadcastToAccount,
      toRepo: (repoId, msg) =>
        toOwner(
          `repository ${repoId}`,
          () =>
            db
              .select({ accountId: repositories.accountId })
              .from(repositories)
              .where(eq(repositories.id, repoId))
              .get(),
          msg,
        ),
      toPr: (prId, msg) =>
        toOwner(
          `pull request ${prId}`,
          () =>
            db
              .select({ accountId: repositories.accountId })
              .from(pullRequests)
              .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
              .where(eq(pullRequests.id, prId))
              .get(),
          msg,
        ),
      toAll: broadcaster.broadcastAll,
    };
  }),
);
