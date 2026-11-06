import { getAgentCapabilities } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { PlanGateError } from "../domain/errors";
import { ChatSessionService } from "../services/ChatSession";
import { resolveChatSessionContext } from "../services/chat/session-context";
import { PrContextService } from "../services/PrContext";
import { SettingsService } from "../services/Settings";
import { PrWorkspace } from "../services/workspace/PrWorkspace";
import { runRoute, withAuth } from "./middleware";
import { ownedBy } from "./ownership";

const decidePlan = (prId: string, planId: string, decision: "approved" | "rejected") =>
  Effect.gen(function* () {
    const chatSessions = yield* ChatSessionService;
    const plan = yield* chatSessions.decidePlan({ prId, planId, decision });
    if (!plan) return yield* Effect.fail(new PlanGateError({ reason: "not-found", planId }));
    return { status: decision, plan };
  });

export const chatInteractionRoutes = new Elysia()
  .use(withAuth)
  .onBeforeHandle(ownedBy({ prId: "pull request" }))
  .patch(
    "/api/chat/:prId/interaction-mode",
    (ctx) => {
      const { mode } = ctx.body;
      return runRoute(
        Effect.gen(function* () {
          const prCtx = yield* PrContextService;
          const workspace = yield* PrWorkspace;
          const chatSessions = yield* ChatSessionService;
          const { pr } = yield* prCtx.forPr(ctx.params.prId);
          const row = yield* workspace.session(pr);
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
  .post(
    "/api/chat/:prId/plan/:planId/approve",
    (ctx) => runRoute(decidePlan(ctx.params.prId, ctx.params.planId, "approved")),
    { params: t.Object({ prId: t.String(), planId: t.String() }) },
  )
  .post(
    "/api/chat/:prId/plan/:planId/reject",
    (ctx) => runRoute(decidePlan(ctx.params.prId, ctx.params.planId, "rejected")),
    { params: t.Object({ prId: t.String(), planId: t.String() }) },
  )
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
