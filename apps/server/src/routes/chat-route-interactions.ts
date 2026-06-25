// ── Interaction sub-router ─────────────────────────────────────────────────
//
// Elysia sub-router for plan/question/agent interaction endpoints.
// Composed into the main chatRoute via `.use()`.

import { existsSync } from "node:fs";
import { type ChatSessionContext, getAgentCapabilities } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { getAcpConnection } from "../ai/acp/acp-connection";
import { applyAcpAgentOverride } from "../ai/acp/presets";
import { logError } from "../logger";
import { AppRuntime } from "../runtime";
import { Broadcaster } from "../services/Broadcaster";
import { ChatSessionService } from "../services/ChatSession";
import { PrContextService } from "../services/PrContext";
import { SettingsService } from "../services/Settings";
import { listRepoFiles, resolveChatReadContext } from "./chat-helpers";
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
            const row = yield* chatSessions.find(pr.id, agent, settings.aiModel, pr.headSha);
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
  // ── Question answer ────────────────────────────────────────────────────
  // The ACP chat transport auto-allows permissions and does not (yet) bridge
  // `askUserQuestion`, so no new question rows are created and there is no live
  // agent run to unblock. This endpoint therefore only persists the user's
  // decision to the authoritative DB row and broadcasts the resolution for
  // cross-tab parity — there is no provider-side resolution to perform. Kept so
  // the web question UI's submit path stays a safe, idempotent no-op (and so any
  // pre-ACP rows left pending in a user's DB can still be marked terminal).
  .post(
    "/api/chat/:prId/question/:questionId/answer",
    async (ctx) => {
      try {
        const { prId, questionId } = ctx.params;
        const { decision, answers, customAnswers } = ctx.body;

        const row = await AppRuntime.runPromise(
          Effect.flatMap(ChatSessionService, (svc) => svc.findQuestion(questionId)),
        );
        if (!row) {
          ctx.set.status = 404;
          return { code: "QUESTION_NOT_FOUND", message: "Question not found" };
        }
        if (row.status !== "pending") {
          // Idempotent: surface the existing terminal state. The web
          // client will reconcile its local item against the broadcast.
          return jsonResponse(
            {
              status: "ok" as const,
              alreadyResolved: true,
              resolution: row.status,
            },
            200,
          );
        }

        // Persist the decision to the authoritative DB row. There is no
        // provider-side run to unblock under ACP — the row IS the resolution.
        const finalStatus: "answered" | "rejected" =
          decision === "reject" ? "rejected" : "answered";
        const decided = await AppRuntime.runPromise(
          Effect.flatMap(ChatSessionService, (svc) =>
            svc.decideQuestion({
              questionId,
              status: finalStatus,
              ...(answers !== undefined ? { answers } : {}),
              ...(customAnswers !== undefined ? { customAnswers } : {}),
            }),
          ),
        );
        if (!decided) {
          ctx.set.status = 404;
          return { code: "QUESTION_NOT_FOUND", message: "Question disappeared mid-write" };
        }

        // ── Auto-supersede pending plan ──────────────────────────
        // If the agent proposed a plan *and* asked a question in the
        // same session, the question answer moves the conversation
        // forward. Leaving the plan pending would block the next
        // POST /api/chat turn via the plan-pending gate, making the
        // agent appear stuck. Supersede it so the gate clears.
        let supersededPlanId: string | null = null;
        try {
          const pending = await AppRuntime.runPromise(
            Effect.flatMap(ChatSessionService, (svc) => svc.findPendingPlan(row.chatSessionId)),
          );
          if (pending) {
            await AppRuntime.runPromise(
              Effect.flatMap(ChatSessionService, (svc) =>
                svc.decidePlan({ planId: pending.id, decision: "superseded" }),
              ),
            );
            supersededPlanId = pending.id;
          }
        } catch (err) {
          logError(
            "chat",
            "auto-supersede pending plan after question answer failed:",
            err instanceof Error ? err.message : String(err),
          );
        }

        // Broadcast to other connected clients so a second tab sees the
        // card flip. Best-effort — the answering client patches its own
        // item locally; this is for cross-tab parity.
        try {
          await AppRuntime.runPromise(
            Effect.gen(function* () {
              const prContext = yield* PrContextService;
              const broadcaster = yield* Broadcaster;
              const { repo } = yield* prContext.resolveBasic(prId, ctx.session.user.id);
              const accountId = yield* prContext.getAccountIdForRepo(repo.id);
              yield* broadcaster.broadcastToAccount(accountId, {
                type: "chat:question-resolved",
                data: {
                  prId,
                  questionId,
                  status: finalStatus,
                  ...(answers !== undefined ? { answers } : {}),
                  ...(customAnswers !== undefined ? { customAnswers } : {}),
                  // Include the superseded plan id so the web client
                  // can flip the plan card locally without a refetch.
                  ...(supersededPlanId ? { supersededPlanId } : {}),
                },
              });
            }),
          );
        } catch (err) {
          logError(
            "chat",
            "chat:question-resolved broadcast failed:",
            err instanceof Error ? err.message : String(err),
          );
        }

        return jsonResponse(
          {
            status: "ok" as const,
            resolution: finalStatus,
            question: decided,
            ...(supersededPlanId ? { supersededPlanId } : {}),
          },
          200,
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      params: t.Object({ prId: t.String(), questionId: t.String() }),
      body: t.Object({
        decision: t.Union([t.Literal("answer"), t.Literal("reject")]),
        answers: t.Optional(t.Record(t.String(), t.Array(t.String()))),
        customAnswers: t.Optional(t.Record(t.String(), t.String())),
      }),
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
      try {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            // Read-only context for the composer's `@`-mention and `/`-command
            // menus. This endpoint fires on every PR selection, so it is
            // deliberately side-effect-free: it does NOT acquire/mutate the
            // worktree and does NOT create or mutate session state. (Acquiring
            // here would run a git fetch + possible `reset --hard` on every PR
            // click and could race an in-flight turn writing the worktree;
            // pre-creating a session would strip the system prompt from the
            // first turn and mask the fresh-start worktree reset.)
            const { settings, agent, existingSessionRow } = yield* resolveChatReadContext(
              ctx.params.prId,
              ctx.session.user.id,
            );

            // Only read the agent + filesystem when a worktree already exists
            // on disk (created by a prior turn). On a fresh PR there is no
            // worktree yet, so we return an empty context — the mention menu
            // still works from the client's changed-file list, and slash
            // commands + the full repo file list fill in after the first turn
            // (the client re-fetches on turn completion).
            const worktreePath = existingSessionRow?.worktreePath ?? null;
            let commands: ChatSessionContext["commands"] = [];
            let promptImage = false;
            let embeddedContext = false;
            let repoFiles: ReadonlyArray<string> = [];

            if (worktreePath && existsSync(worktreePath)) {
              const acpAgent = applyAcpAgentOverride(agent);
              const handle = yield* Effect.promise(() =>
                getAcpConnection(worktreePath, acpAgent, {
                  model: settings.aiModel ?? undefined,
                  thinkingEffort: settings.aiThinkingEffort ?? undefined,
                  contextWindow: settings.aiContextWindow ?? undefined,
                }),
              );
              promptImage = handle.promptImage;
              embeddedContext = handle.embeddedContext;
              // Available slash commands are cached against a live session id,
              // populated as the agent streams `available_commands_update`
              // after a session opens. Empty until the first turn runs.
              const sessionId = existingSessionRow?.sessionId ?? null;
              commands = sessionId
                ? handle.getAvailableCommands(sessionId).map((command) => ({
                    name: command.name,
                    description: command.description,
                  }))
                : [];
              repoFiles = yield* Effect.promise(() => listRepoFiles(worktreePath));
            }

            const response: ChatSessionContext = {
              commands,
              promptImage,
              embeddedContext,
              repoFiles,
            };
            return response;
          }),
        );
        return jsonResponse({ ...result }, 200);
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      params: t.Object({ prId: t.String() }),
    },
  );
