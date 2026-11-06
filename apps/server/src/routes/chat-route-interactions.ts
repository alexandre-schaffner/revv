// ── Interaction sub-router ─────────────────────────────────────────────────
//
// Elysia sub-router for plan/agent interaction endpoints.
// Composed into the main chatRoute via `.use()`.

import { getAgentCapabilities, type StreamErrorBody } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, status, t } from "elysia";
import { resolveAgentLaunch } from "../ai/acp/agent-launch";
import { ChatSessionService } from "../services/ChatSession";
import { PrContextService } from "../services/PrContext";
import { SettingsService } from "../services/Settings";
import { resolveChatSessionContext } from "./chat-helpers";
import { runRoute, withAuth } from "./middleware";
import { ownedBy } from "./ownership";

const decidePlan = (planId: string, decision: "approved" | "rejected") =>
  Effect.gen(function* () {
    const chatSessions = yield* ChatSessionService;
    const plan = yield* chatSessions.decidePlan({ planId, decision });
    if (!plan) {
      return status(404, {
        code: "PLAN_NOT_FOUND",
        message: "Plan not found",
      } satisfies StreamErrorBody);
    }
    return { status: decision, plan };
  });

export const chatInteractionRoutes = new Elysia()
  .use(withAuth)
  .onBeforeHandle(ownedBy({ prId: "pull request" }))
  // ── Interaction mode (plan toggle) ──────────────────────────────────────
  .patch(
    "/api/chat/:prId/interaction-mode",
    (ctx) => {
      const { mode } = ctx.body;
      return runRoute(
        Effect.gen(function* () {
          const prCtx = yield* PrContextService;
          const chatSessions = yield* ChatSessionService;
          const { pr } = yield* prCtx.forPr(ctx.params.prId);
          const { agent, model } = yield* resolveAgentLaunch("chat");
          const row = pr.headSha ? yield* chatSessions.find(pr.id, agent, model, pr.headSha) : null;
          if (row) yield* chatSessions.setInteractionMode({ chatSessionId: row.id, mode });
          return { status: "ok" as const, mode };
        }),
      );
    },
    {
      params: t.Object({ prId: t.String() }),
      body: t.Object({
        mode: t.Union([t.Literal("default"), t.Literal("plan")]),
      }),
    },
  )
  // ── Plan approval ───────────────────────────────────────────────────────
  .post(
    "/api/chat/:prId/plan/:planId/approve",
    (ctx) => runRoute(decidePlan(ctx.params.planId, "approved")),
    { params: t.Object({ prId: t.String(), planId: t.String() }) },
  )
  .post(
    "/api/chat/:prId/plan/:planId/reject",
    (ctx) => runRoute(decidePlan(ctx.params.planId, "rejected")),
    { params: t.Object({ prId: t.String(), planId: t.String() }) },
  )
  // ── Agent availability ─────────────────────────────────────────────────
  // Whether the composer offers Plan mode: a static capability of the
  // configured agent in the shared `ACP_AGENTS` registry.
  .get("/api/chat/agents/available", () =>
    runRoute(
      Effect.gen(function* () {
        const settingsService = yield* SettingsService;
        const agent = yield* settingsService.resolveAgent();
        return { agent, planAvailable: getAgentCapabilities(agent).planMode };
      }),
    ),
  )
  .get(
    "/api/chat/:prId/session-context",
    (ctx) => {
      // Opt-in warm-up. The default fetch (fired on every PR selection) stays
      // side-effect-free: no worktree acquire, no session. With `?warm=1` — sent
      // when the user focuses the composer, signalling real intent to chat — we
      // eagerly acquire the worktree and harvest the agent's slash commands so
      // they're available on a brand-new chat, before the first message.
      const warm = ctx.query.warm === "1" || ctx.query.warm === "true";
      return runRoute(resolveChatSessionContext(ctx.params.prId, warm));
    },
    {
      params: t.Object({ prId: t.String() }),
      query: t.Object({ warm: t.Optional(t.String()) }),
    },
  );
