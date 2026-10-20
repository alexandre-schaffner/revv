// Rebase a stack: every open layer back on top of the one below it, the way
// GitHub's "Rebase stack" button does it, run in Revv's clone and pushed in
// one atomic, leased push.

import type { StackRebaseResult } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { AppRuntime } from "../runtime";
import { StackRebaseService } from "../services/stacks/StackRebase";
import { handleAppError, withAccount } from "./middleware";

const STATUS_FOR = { conflict: 409, moved: 409, invalid: 400, failed: 422 } as const;

export const stackRebaseRoutes = new Elysia({ prefix: "/api" }).use(withAccount).post(
  "/prs/:id/stack/rebase",
  async (ctx): Promise<StackRebaseResult | { error: string; files?: readonly string[] }> => {
    try {
      const result = await AppRuntime.runPromise(
        Effect.flatMap(StackRebaseService, (s) =>
          s.rebase(
            ctx.params.id,
            ctx.session.user.id,
            ctx.account.accountId,
            ctx.body.expectedHeads,
          ),
        ).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          // A refusal is the user's to read ("#122 conflicts with main in…").
          Effect.catchTag("StackRebaseRejectedError", (rejection) =>
            Effect.succeed({ ok: false as const, rejection }),
          ),
        ),
      );
      if (result.ok) return result.value;
      const { reason, message, files } = result.rejection;
      ctx.set.status = STATUS_FOR[reason];
      return files === undefined ? { error: message } : { error: message, files };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  },
  {
    body: t.Object({
      /** Head SHAs the user saw, by PR number; a layer that moved since is never rebased. */
      expectedHeads: t.Record(t.String(), t.String()),
    }),
  },
);
