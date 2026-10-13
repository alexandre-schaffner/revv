// Conversation tab: the PR's GitHub conversation, its CI checks, and the
// writes the sidebar, composer, and checks section make. All of it is
// GitHub-backed through PrConversationService.

import type { ConversationWrite } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, type Static, t } from "elysia";
import { AppRuntime } from "../runtime";
import { PrConversationService } from "../services/PrConversation";
import { handleAppError, withAccount } from "./middleware";

const names = t.Array(t.String({ minLength: 1 }), { minItems: 1, maxItems: 50 });
const someNames = t.Array(t.String({ minLength: 1 }), { maxItems: 50 });
const markdown = t.String({ minLength: 1, maxLength: 65_536 });
const id = t.Integer({ minimum: 1 });

const writeBody = t.Union([
  t.Object({ kind: t.Literal("request_reviewers"), users: someNames, teams: someNames }),
  t.Object({ kind: t.Literal("remove_reviewers"), users: someNames, teams: someNames }),
  t.Object({ kind: t.Literal("add_assignees"), logins: names }),
  t.Object({ kind: t.Literal("remove_assignees"), logins: names }),
  t.Object({ kind: t.Literal("add_labels"), names }),
  t.Object({ kind: t.Literal("remove_labels"), names }),
  t.Object({ kind: t.Literal("post_comment"), body: markdown }),
  t.Object({ kind: t.Literal("edit_comment"), commentId: id, body: markdown }),
  t.Object({ kind: t.Literal("delete_comment"), commentId: id }),
  // An empty description is a legitimate edit.
  t.Object({ kind: t.Literal("edit_body"), body: t.String({ maxLength: 65_536 }) }),
  t.Object({
    kind: t.Literal("rerun_failed"),
    runIds: t.Array(id, { minItems: 1, maxItems: 20 }),
  }),
  t.Object({ kind: t.Literal("rerun_job"), jobId: id }),
]);

// The schema validates what the shared `ConversationWrite` type promises;
// this fails to compile the day the two disagree.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const writeBodyMatchesShared: Same<Static<typeof writeBody>, ConversationWrite> = true;
void writeBodyMatchesShared;

export const prConversationRoutes = new Elysia({ prefix: "/api/prs" })
  .use(withAccount)
  .get("/:id/conversation", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(PrConversationService, (s) =>
          s.load(ctx.params.id, ctx.session.user.id, ctx.account.accountId),
        ),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  // The cached snapshot only, for an instant first paint; null on a miss.
  .get("/:id/conversation/cached", async (ctx) => {
    try {
      const conversation = await AppRuntime.runPromise(
        Effect.flatMap(PrConversationService, (s) =>
          s.cached(ctx.params.id, ctx.session.user.id, ctx.account.accountId),
        ),
      );
      return { conversation };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  .post(
    "/:id/conversation/writes",
    async (ctx) => {
      try {
        const body = ctx.body;
        return await AppRuntime.runPromise(
          Effect.flatMap(PrConversationService, (s) =>
            s.write(ctx.params.id, ctx.session.user.id, ctx.account.accountId, body),
          ),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { body: writeBody },
  )

  .get("/:id/checks", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(PrConversationService, (s) =>
          s.checks(ctx.params.id, ctx.session.user.id, ctx.account.accountId),
        ),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  .get(
    "/:id/checks/:checkRunId",
    async (ctx) => {
      try {
        return await AppRuntime.runPromise(
          Effect.flatMap(PrConversationService, (s) =>
            s.checkDetails(
              ctx.params.id,
              ctx.session.user.id,
              ctx.account.accountId,
              ctx.params.checkRunId,
            ),
          ),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { params: t.Object({ id: t.String(), checkRunId: t.Numeric({ minimum: 1 }) }) },
  )

  .get("/:id/label-options", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(PrConversationService, (s) =>
          s.labelOptions(ctx.params.id, ctx.session.user.id, ctx.account.accountId),
        ),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  .get(
    "/:id/assignee-options",
    async (ctx) => {
      try {
        return await AppRuntime.runPromise(
          Effect.flatMap(PrConversationService, (s) =>
            s.assigneeOptions(
              ctx.params.id,
              ctx.session.user.id,
              ctx.account.accountId,
              ctx.query.q ?? "",
            ),
          ),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { query: t.Object({ q: t.Optional(t.String({ maxLength: 100 })) }) },
  )

  .get(
    "/:id/reviewer-options",
    async (ctx) => {
      try {
        return await AppRuntime.runPromise(
          Effect.flatMap(PrConversationService, (s) =>
            s.reviewerOptions(
              ctx.params.id,
              ctx.session.user.id,
              ctx.account.accountId,
              ctx.query.q ?? "",
            ),
          ),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { query: t.Object({ q: t.Optional(t.String({ maxLength: 100 })) }) },
  );
