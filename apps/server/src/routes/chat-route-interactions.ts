// ── Interaction sub-router ─────────────────────────────────────────────────
//
// Elysia sub-router for plan/question/agent interaction endpoints.
// Composed into the main chatRoute via `.use()`.

import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { logError } from "../logger";
import { AppRuntime } from "../runtime";
import { Broadcaster } from "../services/Broadcaster";
import { ChatSessionService } from "../services/ChatSession";
import { OpencodeSupervisor } from "../services/OpencodeSupervisor";
import { takePendingQuestion } from "../services/PendingQuestionRegistry";
import { PrContextService } from "../services/PrContext";
import { SettingsService } from "../services/Settings";
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
            const agent = yield* settingsService
              .resolveAgent()
              .pipe(Effect.orElseSucceed(() => "opencode" as const));
            if (!pr.headSha) return;
            const row = yield* chatSessions.find(pr.id, agent, pr.headSha);
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
  // One endpoint handles both providers. Branch on the row's `source`:
  //   • claude:  resolve the in-memory deferred from PendingQuestionRegistry
  //              with a `behavior: 'deny'` PermissionResult carrying the
  //              user's answers JSON-stringified. The SDK delivers that
  //              message back to the model as the tool_result; the next
  //              assistant message resumes the turn.
  //   • opencode: POST to the daemon's `/question/{id}/reply` (or `/reject`)
  //              which is what actually unblocks the daemon-side agent.
  //              The daemon then broadcasts `question.replied` on its SSE
  //              channel; our subscribeOpencodeStream surfaces that as a
  //              follow-up frame which calls decideQuestion idempotently.
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

        // Persist FIRST so the DB row is authoritative even if the
        // downstream provider call fails. If the resolve path below
        // errors out we still leave the row marked terminal — the
        // in-memory deferred (claude) will reject naturally on stream
        // close, and the opencode daemon will time out on its end.
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

        if (row.source === "claude") {
          const deferred = takePendingQuestion(row.providerRequestId);
          if (!deferred) {
            // Driver already cleaned up (stream closed, restart, etc).
            // DB row is now marked terminal; return 410 so the web
            // client can surface a "question expired" message and
            // remove the pending UI.
            ctx.set.status = 410;
            return {
              code: "QUESTION_EXPIRED",
              message:
                "The agent run that asked this question has ended. Send a new message to continue.",
            };
          }
          if (finalStatus === "rejected") {
            deferred.resolve({
              behavior: "deny",
              message: "User declined to answer the question.",
              interrupt: false,
            });
          } else {
            // Format the result so the model sees a complete payload.
            // Claude's `AskUserQuestionOutput` shape uses
            // `answers: Record<questionText, "label1, label2">` —
            // match it. Optional free-text customAnswers appended as
            // a parenthetical so the model can still read it even
            // though Claude's spec doesn't include it.
            //
            // Elysia's `t.Record(...)` validator infers the body
            // fields as `{}` at the type level, so we cast through
            // the schema we already validated against (Elysia
            // guarantees the runtime shape matches).
            const answersMap = (answers ?? {}) as Record<string, ReadonlyArray<string>>;
            const customMap = (customAnswers ?? {}) as Record<string, string>;
            const flatAnswers: Record<string, string> = {};
            for (const [q, labels] of Object.entries(answersMap)) {
              const custom = customMap[q];
              flatAnswers[q] = custom
                ? labels.length > 0
                  ? `${labels.join(", ")} (custom: ${custom})`
                  : `(custom: ${custom})`
                : labels.join(", ");
            }
            deferred.resolve({
              behavior: "deny",
              message: JSON.stringify({
                questions: row.questions,
                answers: flatAnswers,
              }),
              interrupt: false,
            });
          }
        } else {
          // opencode: hit the daemon via `client.question.{reply,reject}`.
          // The daemon's follow-up SSE event will hit
          // subscribeOpencodeStream and fall through to the idempotent
          // decideQuestion in the stream wrapper — no double-write because
          // the row is already non-pending.
          //
          // 404 = the daemon already cleared the request (e.g. the agent
          // timed out). Treat as success in both branches.
          const client = await AppRuntime.runPromise(
            Effect.gen(function* () {
              const supervisor = yield* OpencodeSupervisor;
              yield* supervisor.ensureRunning();
              return yield* supervisor.client();
            }),
          );
          if (!client) {
            throw new Error("opencode daemon not running");
          }
          if (finalStatus === "rejected") {
            const result = await client.question.reject({
              requestID: row.providerRequestId,
            });
            if (result.error && result.response.status !== 404) {
              throw new Error(
                `opencode reject failed: ${result.response.status} ${result.response.statusText}`,
              );
            }
          } else {
            // Reconstruct opencode's positional `Array<Array<string>>`
            // answer order from `(question text → labels)` using the
            // original question list as the canonical order.
            const answersMap = (answers ?? {}) as Record<string, ReadonlyArray<string>>;
            const orderedAnswers: Array<Array<string>> = row.questions.map((q) =>
              Array.from(answersMap[q.question] ?? []),
            );
            const result = await client.question.reply({
              requestID: row.providerRequestId,
              answers: orderedAnswers,
            });
            if (result.error && result.response.status !== 404) {
              throw new Error(
                `opencode reply failed: ${result.response.status} ${result.response.statusText}`,
              );
            }
          }
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
  // Lightweight probe the frontend uses to decide whether to enable the
  // composer's Plan-mode toggle for the opencode path. For Claude the
  // toggle is always available (the SDK supplies `permissionMode: 'plan'`).
  .get("/api/chat/agents/available", async (ctx) => {
    try {
      const result = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const settingsService = yield* SettingsService;
          const agent = yield* settingsService
            .resolveAgent()
            .pipe(Effect.orElseSucceed(() => "opencode" as const));
          if (agent === "claude") {
            return {
              agent: "claude" as const,
              agents: ["plan", "general-purpose"] as readonly string[],
              // Claude SDK exposes plan mode via permissionMode.
              planAvailable: true,
            };
          }
          // opencode: probe the supervisor's cached agent list.
          const supervisor = yield* OpencodeSupervisor;
          const agents = yield* supervisor.listAgents();
          return {
            agent: "opencode" as const,
            agents,
            planAvailable: agents.includes("plan"),
          };
        }),
      );
      return jsonResponse(result, 200);
    } catch (e) {
      return handleAppError(e, ctx);
    }
  });
