// ── Interaction sub-router ─────────────────────────────────────────────────
//
// Elysia sub-router for plan/question/agent interaction endpoints.
// Composed into the main chatRoute via `.use()`.

import { getAgentCapabilities } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { AppRuntime } from "../runtime";
import { ChatSessionService } from "../services/ChatSession";
import { PrContextService } from "../services/PrContext";
import { SettingsService } from "../services/Settings";
import { chatSessionModel, resolveChatSessionContext } from "./chat-helpers";
import { handleAppError, jsonResponse, withAuth } from "./middleware";

export const chatInteractionRoutes = new Elysia()
  .use(withAuth)
  // ── Interaction mode (plan toggle) ──────────────────────────────────────
  .patch(
    "/api/chat/:prId/interaction-mode",
    async (ctx) => {
      const body = (ctx.body ?? {}) as { mode?: unknown };
      if (body.mode !== "plan" && body.mode !== "default") {
        ctx.set.status = 400;
        return { error: "mode must be 'plan' or 'default'" };
      }
      const mode: "plan" | "default" = body.mode;
      try {
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const { pr } = yield* prCtx.resolveBasic(ctx.params.prId, ctx.session.user.id);
            const settings = yield* settingsService.getSettings();
            const agent = yield* settingsService.resolveChatAgentId();
            if (!pr.headSha) return;
            const row = yield* chatSessions.find(
              pr.id,
              agent,
              chatSessionModel(agent, settings.aiModel),
              pr.headSha,
            );
            if (!row) return;
            yield* chatSessions.setInteractionMode({
              chatSessionId: row.id,
              mode,
            });
          }),
        );
        return jsonResponse({ status: "ok", mode }, 200);
      } catch (e) {
        return handleAppError(e, ctx);
      }
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
    async (ctx) => {
      try {
        const result = await AppRuntime.runPromise(
          Effect.flatMap(ChatSessionService, (svc) =>
            svc.decidePlan({
              planId: ctx.params.planId,
              decision: "approved",
            }),
          ),
        );
        if (!result) {
          ctx.set.status = 404;
          return { code: "PLAN_NOT_FOUND", message: "Plan not found" };
        }
        return jsonResponse({ status: "approved", plan: result }, 200);
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      params: t.Object({ prId: t.String(), planId: t.String() }),
    },
  )
  .post(
    "/api/chat/:prId/plan/:planId/reject",
    async (ctx) => {
      try {
        const result = await AppRuntime.runPromise(
          Effect.flatMap(ChatSessionService, (svc) =>
            svc.decidePlan({
              planId: ctx.params.planId,
              decision: "rejected",
            }),
          ),
        );
        if (!result) {
          ctx.set.status = 404;
          return { code: "PLAN_NOT_FOUND", message: "Plan not found" };
        }
        return jsonResponse({ status: "rejected", plan: result }, 200);
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      params: t.Object({ prId: t.String(), planId: t.String() }),
    },
  )
  // ── Agent availability ─────────────────────────────────────────────────
  // Lightweight lookup the frontend uses to decide whether to enable the
  // composer's Plan-mode toggle. Plan-mode support is a static per-agent
  // capability defined once in the shared `ACP_AGENTS` registry, so this
  // endpoint just echoes the configured agent and its `planMode` flag —
  // adding a new agent never requires touching this handler.
  .get("/api/chat/agents/available", async (ctx) => {
    try {
      const result = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const settingsService = yield* SettingsService;
          const agent = yield* settingsService.resolveChatAgentId();
          return { agent, planAvailable: getAgentCapabilities(agent).planMode };
        }),
      );
      return jsonResponse(result, 200);
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .get(
    "/api/chat/:prId/session-context",
    async (ctx) => {
      // Opt-in warm-up. The default fetch (fired on every PR selection) stays
      // side-effect-free: no worktree acquire, no session. With `?warm=1` — sent
      // when the user focuses the composer, signalling real intent to chat — we
      // eagerly acquire the worktree and harvest the agent's slash commands so
      // they're available on a brand-new chat, before the first message.
      const warm = ctx.query.warm === "1" || ctx.query.warm === "true";
      try {
        const result = await AppRuntime.runPromise(
          resolveChatSessionContext(ctx.params.prId, ctx.session.user.id, warm),
        );
        return jsonResponse({ ...result }, 200);
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      params: t.Object({ prId: t.String() }),
      query: t.Object({ warm: t.Optional(t.String()) }),
    },
  );
