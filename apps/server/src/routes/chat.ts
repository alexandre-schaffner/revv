// ── Chat route ─────────────────────────────────────────────────────────────
//
// The right-pane AI chat HTTP surface.
//
//   POST   /api/chat                                - stream a turn (SSE)
//   GET    /api/chat/:prId/messages                 - load persisted timeline
//   GET    /api/chat/:prId/proposed-changes         - list commits the agent made
//   GET    /api/chat/:prId/proposed-changes/:sha/diff - unified diff for one
//   DELETE /api/chat/:prId                          - clear the conversation
//
// Sessions are persisted in `chat_sessions` keyed on (prId, agent, prHeadSha).
// The full transcript (user + assistant messages, structured tool-use rows)
// lives in `chat_messages` and `chat_activities` so it survives desktop
// reloads, daemon restarts, and the agent's own session-storage churn (gap
// A1 + C1 from the gap-analysis roadmap). The agent-side session id is
// still tracked so follow-up turns resume the same provider context.

import { existsSync } from "node:fs";
import {
  attachmentByteSize,
  attachmentsTotalTooLargeMessage,
  attachmentTooLargeMessage,
  type ChatAttachment,
  type ChatAttachmentMetadata,
  type InteractionMode,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENTS_COUNT,
  MAX_CHAT_ATTACHMENTS_TOTAL_BYTES,
} from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import type { ChatHistoryEntry } from "../ai/prompts/chat";
import { AgentUnavailableError } from "../ai/providers/chat-agent-errors";
import type { ChatStreamFrame } from "../ai/providers/chat-types";
import { WorktreeBlockedByUnpushedCommits } from "../domain/errors";
import { logError } from "../logger";
import { AppRuntime } from "../runtime";
import { AiService } from "../services/Ai";
import { ChatChangesPushService } from "../services/ChatChangesPush";
import { ChatSessionService } from "../services/ChatSession";
import { DbService } from "../services/Db";
import { PrContextService } from "../services/PrContext";
import { SettingsService } from "../services/Settings";
import {
  discardAgentCommits,
  fetchWalkthroughContext,
  resolveChatTurnContext,
  wrapStreamWithPersistence,
} from "./chat-helpers";
import { chatInteractionRoutes } from "./chat-route-interactions";
import { chatProposedChangesRoutes } from "./chat-route-proposed-changes";
import {
  chatStreamToSSE,
  handleAppError,
  jsonResponse,
  mapErrorToSSEResponse,
  unwrapEffectError,
  withAuth,
} from "./middleware";

// ── Route ──────────────────────────────────────────────────────────────────

// Valid base64 alphabet, optional `=` padding, length a multiple of 4. Used to
// confirm an attachment the client labelled `image` actually carries base64
// bytes (and not, say, raw text mislabelled as an image).
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// Defense-in-depth bound on a single attachment's raw `data` string, enforced
// at the schema layer. This just rejects an absurd single field early; the
// authoritative, per-kind decoded-byte caps live in `validateAttachments`.
// Sized for the worst case — base64 image data, which inflates the byte cap by
// ~4/3, plus slack. For `text` attachments (`data` is raw UTF-8, ~1 byte/char)
// this cap therefore over-permits by ~33%; that is intentional — text relies
// entirely on the decoded-byte check in `validateAttachments`, this bound only
// exists to stop a pathologically huge single field. (Bun's global body limit
// remains the real parse-time memory guard.)
const MAX_ATTACHMENT_DATA_CHARS = Math.ceil((MAX_CHAT_ATTACHMENT_BYTES * 4) / 3) + 1024;

/**
 * Sanity-check the client-asserted `kind` at the trust boundary so downstream
 * consumers (size accounting in `attachmentByteSize`, the ACP render branch in
 * `buildPromptBlocks`) can rely on `kind` matching the payload shape — an
 * `image` carries non-empty base64 with an image MIME type; `text` does not
 * claim an image type. This is a cheap structural guard, not a semantic one:
 * valid base64 is not necessarily a decodable image (that's the agent's
 * problem). Returns a structured error string on mismatch.
 */
function validateAttachmentKind(attachment: ChatAttachment): string | null {
  if (attachment.kind === "image") {
    if (!attachment.mimeType.startsWith("image/")) {
      return `${attachment.name} is labelled an image but has a non-image type.`;
    }
    if (
      attachment.data.length === 0 ||
      attachment.data.length % 4 !== 0 ||
      !BASE64_RE.test(attachment.data)
    ) {
      return `${attachment.name} is not valid base64 image data.`;
    }
    return null;
  }
  // Text attachments carry raw UTF-8; reject anything claiming an image type.
  if (attachment.mimeType.startsWith("image/")) {
    return `${attachment.name} has an image type but was sent as text.`;
  }
  return null;
}

type AttachmentValidation =
  | { ok: true; metadata: ChatAttachmentMetadata[] }
  | {
      ok: false;
      status: 413 | 415;
      code: "ATTACHMENT_TOO_LARGE" | "ATTACHMENT_INVALID";
      message: string;
    };

function validateAttachments(
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): AttachmentValidation {
  if (!attachments || attachments.length === 0) return { ok: true, metadata: [] };
  let total = 0;
  const metadata: ChatAttachmentMetadata[] = [];
  for (const attachment of attachments) {
    const kindError = validateAttachmentKind(attachment);
    if (kindError) {
      return { ok: false, status: 415, code: "ATTACHMENT_INVALID", message: kindError };
    }
    const size = attachmentByteSize(attachment);
    if (size > MAX_CHAT_ATTACHMENT_BYTES) {
      return {
        ok: false,
        status: 413,
        code: "ATTACHMENT_TOO_LARGE",
        message: attachmentTooLargeMessage(attachment.name),
      };
    }
    total += size;
    if (total > MAX_CHAT_ATTACHMENTS_TOTAL_BYTES) {
      return {
        ok: false,
        status: 413,
        code: "ATTACHMENT_TOO_LARGE",
        message: attachmentsTotalTooLargeMessage(),
      };
    }
    metadata.push({
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size,
    });
  }
  return { ok: true, metadata };
}

export const chatRoute = new Elysia()
  .use(withAuth)
  .post(
    "/api/chat",
    async (ctx) => {
      try {
        const attachments = ctx.body.attachments ?? [];
        const attachmentValidation = validateAttachments(attachments);
        if (!attachmentValidation.ok) {
          ctx.set.status = attachmentValidation.status;
          return {
            code: attachmentValidation.code,
            message: attachmentValidation.message,
          };
        }
        const requestedMode: InteractionMode | undefined =
          ctx.body.interactionMode === "plan" || ctx.body.interactionMode === "default"
            ? ctx.body.interactionMode
            : undefined;
        const approvedPlanIdInput =
          typeof ctx.body.approvedPlanId === "string" && ctx.body.approvedPlanId.length > 0
            ? ctx.body.approvedPlanId
            : undefined;
        const prepared = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const ai = yield* AiService;
            const chatSessions = yield* ChatSessionService;
            const chatPush = yield* ChatChangesPushService;
            const { db } = yield* DbService;

            // Shared bootstrap: PR/repo/token, head SHA, agent/model, the
            // existing session row (read-only), and the per-PR worktree. The
            // worktree preserves a descendant HEAD (unpushed agent commits
            // from a prior turn) and only resets when its base diverges from
            // `prHeadSha` (PR head moved on the remote).
            const { pr, headSha, agent, model, worktreePath, branchName, existingSessionRow } =
              yield* resolveChatTurnContext(ctx.body.prId, ctx.session.user.id);

            // No row means this is a fresh start (e.g. the user just cleared
            // chat), so after acquiring the worktree we hard-reset it — stale
            // agent commits may have survived the clear if the reset raced
            // with this new message.
            const isFreshStart = existingSessionRow === null;

            // Fresh start: hard-reset the worktree to `prHeadSha`
            // so any stale agent commits that survived the clear
            // (due to a race between discardAgentCommits and this
            // handler) are unconditionally removed.
            if (isFreshStart) {
              yield* Effect.promise(() =>
                discardAgentCommits({
                  worktreePath,
                  branchName,
                  prHeadSha: headSha,
                }),
              );
            }

            // Eagerly create (or look up) the chat_sessions row so
            // chat_messages and chat_activities can FK to it BEFORE
            // the agent emits its session id. The agent-side id
            // arrives mid-stream via onSessionId and is patched in.
            const chatSessionRow = yield* chatSessions.findOrCreate({
              prId: pr.id,
              agent,
              model,
              prHeadSha: headSha,
              worktreePath,
              branchName,
            });

            // Plan-pending gate. If the most recent plan is still
            // pending and the user didn't explicitly approve it,
            // refuse the turn so the user has to either approve,
            // reject, or refine instead of accidentally moving past
            // it. Tagged return — the outer await unwraps and
            // surfaces a 409 to the client.
            const pendingPlan = yield* chatSessions.findPendingPlan(chatSessionRow.id);
            if (pendingPlan && pendingPlan.id !== approvedPlanIdInput) {
              return { kind: "plan-pending" as const, planId: pendingPlan.id };
            }

            // Question-pending gate. The previous turn left an
            // askUserQuestion / question.asked open and the user
            // hasn't answered it. Refusing the next prompt keeps the
            // agent's tool-loop state consistent:
            //   • Claude: the SDK's canUseTool is still awaiting our
            //     in-memory deferred; starting a new turn would
            //     leave that deferred orphaned forever.
            //   • Opencode: the daemon won't accept a new
            //     session.prompt while one is in-flight anyway —
            //     surface the cleaner error instead of letting the
            //     opencode call fail with a less helpful message.
            const pendingQuestion = yield* chatSessions.findPendingQuestion(chatSessionRow.id);
            if (pendingQuestion) {
              return {
                kind: "question-pending" as const,
                questionId: pendingQuestion.id,
              };
            }

            // Approval path: if the user is approving a plan, mark
            // it approved before kicking off the execution turn.
            // Also flip the session out of plan mode so the agent
            // can actually mutate the worktree this turn.
            if (approvedPlanIdInput) {
              const decided = yield* chatSessions.decidePlan({
                planId: approvedPlanIdInput,
                decision: "approved",
              });
              if (!decided) {
                return { kind: "plan-not-found" as const, planId: approvedPlanIdInput };
              }
              yield* chatSessions.setInteractionMode({
                chatSessionId: chatSessionRow.id,
                mode: "default",
              });
            } else if (requestedMode !== undefined) {
              yield* chatSessions.setInteractionMode({
                chatSessionId: chatSessionRow.id,
                mode: requestedMode,
              });
            }

            // Effective mode for this turn. After approval, we run
            // in 'default'. Otherwise: requested mode override, or
            // fall back to the session's stored mode.
            const effectiveMode: InteractionMode = approvedPlanIdInput
              ? "default"
              : (requestedMode ?? chatSessionRow.interactionMode);

            // "Resume" semantics: present only once the agent has
            // emitted a session id on a previous turn. A fresh row
            // (sessionId === null) means we're starting from scratch.
            const resumeSessionId = chatSessionRow.sessionId ?? null;

            // On new session, fetch walkthrough context for the system prompt.
            // On resume, the agent already has it baked into its persisted session.
            const walkthrough = resumeSessionId ? null : fetchWalkthroughContext(db, pr.id);

            // Snapshot the prior transcript BEFORE appending the new
            // user message so the agent's history block doesn't end
            // with a duplicate of the message it's about to receive.
            // Plans / tasks / sub-agents aren't surfaced in the
            // prompt's history block (they have their own dedicated
            // surfaces) — drop them here.
            const priorTimeline = yield* chatSessions.listTimeline(chatSessionRow.id);
            const history: ChatHistoryEntry[] = [];
            for (const e of priorTimeline) {
              if (e.entryKind === "message") {
                history.push({
                  entryKind: "message",
                  role: e.role,
                  content: e.content,
                });
              } else if (e.entryKind === "activity") {
                history.push({
                  entryKind: "activity",
                  activityKind: e.activityKind,
                  toolName: e.toolName,
                  summary: e.summary,
                });
              }
              // task-list / plan / subagent: skipped — they're rendered
              // from their own tables via the frontend timeline.
            }

            // Append the user message immediately so it persists even
            // if the agent process never emits anything (timeout, crash).
            const turnId = crypto.randomUUID();
            yield* chatSessions.appendUserMessage({
              chatSessionId: chatSessionRow.id,
              turnId,
              content: ctx.body.message,
              attachments: attachmentValidation.metadata,
            });

            // Synchronous-by-await: drivers must await this before
            // streaming any user-visible content (opencode) or before
            // closing their stream (claude). That serializes the
            // SQLite write so a follow-up `chatSessions.find()` for
            // the same (prId, agent, headSha) reliably sees the row,
            // preventing the "fresh session on resend" race.
            const onSessionId = async (sid: string): Promise<void> => {
              try {
                await AppRuntime.runPromise(
                  chatSessions.setAgentSessionId({
                    chatSessionId: chatSessionRow.id,
                    sessionId: sid,
                    worktreePath,
                    branchName,
                  }),
                );
              } catch (err) {
                logError(
                  "chat",
                  "chatSessions.setAgentSessionId failed:",
                  err instanceof Error ? err.message : String(err),
                );
              }
            };

            const frameStream = yield* ai.chat({
              pr: {
                title: pr.title,
                body: pr.body,
                sourceBranch: pr.sourceBranch,
                targetBranch: pr.targetBranch,
              },
              walkthrough,
              message: ctx.body.message,
              attachments,
              history,
              cwd: worktreePath,
              branchName,
              resumeSessionId,
              onSessionId,
              prId: pr.id,
              userId: ctx.session.user.id,
              interactionMode: effectiveMode,
            });

            // Mark this PR as streaming so a concurrent push attempt
            // is refused (the agent might write to the worktree at
            // any moment, which would race with the push's
            // `git checkout` / `git merge`).
            chatPush.markChatStreaming(pr.id, true);

            return {
              kind: "ok" as const,
              frameStream,
              chatSessionId: chatSessionRow.id,
              turnId,
              prId: pr.id,
            };
          }),
        );

        if (prepared.kind === "plan-pending") {
          ctx.set.status = 409;
          return {
            code: "PLAN_PENDING",
            planId: prepared.planId,
            message:
              "A plan is awaiting your decision. Approve or reject it before sending a new message.",
          };
        }
        if (prepared.kind === "plan-not-found") {
          ctx.set.status = 404;
          return {
            code: "PLAN_NOT_FOUND",
            planId: prepared.planId,
            message: "Plan not found",
          };
        }
        if (prepared.kind === "question-pending") {
          ctx.set.status = 409;
          return {
            code: "QUESTION_PENDING",
            questionId: prepared.questionId,
            message:
              "The agent is waiting for your answer to an open question. Answer it before sending a new message.",
          };
        }

        const persistedStream = wrapStreamWithPersistence(prepared.frameStream, {
          chatSessionId: prepared.chatSessionId,
          turnId: prepared.turnId,
          // All chat runs on the ACP transport; the specific registry agent is
          // a launch detail. `source` records the transport.
          agent: "acp",
        });

        // Wrap the persisted stream so we clear the streaming flag
        // when the SSE consumer finishes — success, error, or client
        // disconnect.
        const streamingPrId = prepared.prId;
        const flagClearingStream = new ReadableStream<ChatStreamFrame>({
          async start(controller) {
            const reader = persistedStream.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
              controller.close();
            } catch (err) {
              controller.error(err);
            } finally {
              try {
                await AppRuntime.runPromise(
                  Effect.flatMap(ChatChangesPushService, (svc) =>
                    Effect.sync(() => svc.markChatStreaming(streamingPrId, false)),
                  ),
                );
              } catch {
                /* never throw from streaming-flag cleanup */
              }
            }
          },
        });

        return new Response(chatStreamToSSE<ChatStreamFrame>(flagClearingStream), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      } catch (e) {
        // Special case: worktree is blocked by unpushed agent commits.
        // Return a structured JSON 409 so the client can show the
        // blocked-commits UI instead of treating it as a generic error.
        const blockedErr = unwrapEffectError(e);
        if (blockedErr instanceof WorktreeBlockedByUnpushedCommits) {
          ctx.set.status = 409;
          return {
            code: "WORKTREE_BLOCKED",
            message: "PR head advanced but worktree has unpushed agent commits",
            worktreePath: blockedErr.worktreePath,
            branchName: blockedErr.branchName,
            oldHeadSha: blockedErr.oldHeadSha,
            newHeadSha: blockedErr.newHeadSha,
            commits: blockedErr.commits,
          };
        }
        // Plan mode requested but the daemon has no `plan` agent.
        if (blockedErr instanceof AgentUnavailableError) {
          ctx.set.status = 422;
          return {
            code: "AGENT_UNAVAILABLE",
            agentName: blockedErr.agentName,
            message: blockedErr.message,
          };
        }
        return mapErrorToSSEResponse(e);
      }
    },
    {
      body: t.Object({
        prId: t.String(),
        message: t.String(),
        attachments: t.Optional(
          t.Array(
            t.Object({
              kind: t.Union([t.Literal("image"), t.Literal("text")]),
              name: t.String({ maxLength: 1024 }),
              mimeType: t.String({ maxLength: 256 }),
              data: t.String({ maxLength: MAX_ATTACHMENT_DATA_CHARS }),
            }),
            { maxItems: MAX_CHAT_ATTACHMENTS_COUNT },
          ),
        ),
        interactionMode: t.Optional(t.Union([t.Literal("default"), t.Literal("plan")])),
        approvedPlanId: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/api/chat/:prId/messages",
    async (ctx) => {
      try {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const { pr } = yield* prCtx.resolveBasic(ctx.params.prId, ctx.session.user.id);
            const settings = yield* settingsService.getSettings();
            const agent = yield* settingsService.resolveChatAgentId();

            if (!pr.headSha) return null;

            // Resolve the chat session for the *current* head SHA
            // only. Older SHAs are dormant — the user has moved on
            // and a fresh PR commit creates a fresh session row.
            const row = yield* chatSessions.find(pr.id, agent, settings.aiModel, pr.headSha);
            if (!row) return null;

            const timeline = yield* chatSessions.listTimeline(row.id);
            return { row, timeline };
          }),
        );

        if (!result) {
          return jsonResponse(
            { chatSessionId: null, entries: [], interactionMode: "default" },
            200,
          );
        }

        return jsonResponse(
          {
            chatSessionId: result.row.id,
            entries: result.timeline,
            interactionMode: result.row.interactionMode,
          },
          200,
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      params: t.Object({ prId: t.String() }),
    },
  )
  .delete(
    "/api/chat/:prId",
    async (ctx) => {
      try {
        const latest = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const { pr } = yield* prCtx.resolveBasic(ctx.params.prId, ctx.session.user.id);
            const agent = yield* settingsService.resolveChatAgentId();

            // Capture the active worktree before dropping rows so we
            // can rewind it to the PR head SHA below — clearing the
            // conversation also discards any unpushed agent commits
            // the user accumulated during this session.
            const activeRow = yield* chatSessions.findLatestForPr(pr.id, agent);

            // Drop every chat-session row for (pr, agent). The
            // per-PR worktree itself stays put — it's shared with
            // walkthrough generation and re-used across chat
            // sessions, refreshed in place on the next acquire.
            yield* chatSessions.clearAllForPr(pr.id, agent);

            return activeRow;
          }),
        );

        if (latest && existsSync(latest.worktreePath)) {
          await discardAgentCommits({
            worktreePath: latest.worktreePath,
            branchName: latest.branchName,
            prHeadSha: latest.prHeadSha,
          });
        }

        return new Response(null, { status: 204 });
      } catch (e) {
        ctx.set.status = 500;
        return handleAppError(e, ctx);
      }
    },
    {
      params: t.Object({ prId: t.String() }),
    },
  )
  .use(chatProposedChangesRoutes)
  .use(chatInteractionRoutes);
