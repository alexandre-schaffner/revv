// Conversation tab: the PR's GitHub conversation, its CI checks, and the
// writes the sidebar, composer, and checks section make. All of it is
// GitHub-backed through PrConversationService.

import type { ConversationWrite } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, type Static, t } from "elysia";
import { PrConversationService } from "../services/PrConversation";
import { runRoute, withAccount } from "./middleware";
import { ownedBy } from "./ownership";

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
  .onBeforeHandle(ownedBy({ id: "pull request" }))
  .get("/:id/conversation", (ctx) =>
    runRoute(
      Effect.flatMap(PrConversationService, (s) => s.load(ctx.params.id, ctx.account.accountId)),
    ),
  )

  // The cached snapshot only, for an instant first paint; null on a miss.
  .get("/:id/conversation/cached", (ctx) =>
    runRoute(
      Effect.flatMap(PrConversationService, (s) =>
        s.cached(ctx.params.id, ctx.account.accountId),
      ).pipe(Effect.map((conversation) => ({ conversation }))),
    ),
  )

  .post(
    "/:id/conversation/writes",
    async (ctx) => {
      const body = ctx.body;
      return runRoute(
        Effect.flatMap(PrConversationService, (s) =>
          s.write(ctx.params.id, ctx.account.accountId, body),
        ),
      );
    },
    { body: writeBody },
  )

  .get("/:id/checks", (ctx) =>
    runRoute(
      Effect.flatMap(PrConversationService, (s) => s.checks(ctx.params.id, ctx.account.accountId)),
    ),
  )

  .get(
    "/:id/checks/:checkRunId",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrConversationService, (s) =>
          s.checkDetails(ctx.params.id, ctx.account.accountId, ctx.params.checkRunId),
        ),
      ),
    { params: t.Object({ id: t.String(), checkRunId: t.Numeric({ minimum: 1 }) }) },
  )

  .get("/:id/label-options", (ctx) =>
    runRoute(
      Effect.flatMap(PrConversationService, (s) =>
        s.labelOptions(ctx.params.id, ctx.account.accountId),
      ),
    ),
  )

  .get(
    "/:id/assignee-options",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrConversationService, (s) =>
          s.assigneeOptions(ctx.params.id, ctx.account.accountId, ctx.query.q ?? ""),
        ),
      ),
    { query: t.Object({ q: t.Optional(t.String({ maxLength: 100 })) }) },
  )

  .get(
    "/:id/reviewer-options",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrConversationService, (s) =>
          s.reviewerOptions(ctx.params.id, ctx.account.accountId, ctx.query.q ?? ""),
        ),
      ),
    { query: t.Object({ q: t.Optional(t.String({ maxLength: 100 })) }) },
  );
