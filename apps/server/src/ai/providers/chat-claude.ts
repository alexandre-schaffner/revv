// ── chat-claude ─────────────────────────────────────────────────────────────
//
// Claude Agent SDK driver for the right-pane chat. Wraps `query()` with
// `persistSession: true` (writes the session JSONL under
// `~/.claude/projects/<dir>/<sessionId>.jsonl`) and either fresh-session or
// `resume: <sessionId>` semantics so multi-turn conversation history lives on
// the agent side, not in our prompt.
//
// Streaming decode (text/reasoning/tool-call extraction from SDK messages)
// lives in `../agent-stream.ts`. This file owns chat-specific concerns only:
// surface filtering (`SURFACED_TOOLS`), MCP review-context registration,
// session-id reporting, and the mapping from `NormalizedAgentEvent` to
// `ChatStreamFrame`.

import { type PermissionResult, query } from "@anthropic-ai/claude-agent-sdk";
import type { InteractionMode, ThreadEventMessage, WalkthroughStreamEvent } from "@revv/shared";
import { Effect } from "effect";
import type { Db } from "../../db";
import { AiGenerationError } from "../../domain/errors";
import { logError } from "../../logger";
import { AppRuntime } from "../../runtime";
import { Broadcaster } from "../../services/Broadcaster";
import {
  registerPendingQuestion,
  takePendingQuestion,
} from "../../services/PendingQuestionRegistry";
import { PrContextService } from "../../services/PrContext";
import { RemoteWalkthroughCache } from "../../services/RemoteWalkthroughCache";
import { RepositoryService } from "../../services/Repository";
import { WalkthroughJobs } from "../../services/WalkthroughJobs";
import {
  buildActivity,
  fluidEmit,
  normalizeClaudeAskUserQuestionInput,
  walkClaudeMessages,
} from "../agent-stream";
import { EDIT_TOOL_SPECS } from "./chat-edit-tools";
import { createChatMcpServer } from "./chat-mcp-tools";
import type { RawChatStreamFrame } from "./chat-types";
import { resolveCliBin } from "./cli-agent";

export type { ChatStreamFrame, RawChatStreamFrame } from "./chat-types";

export interface StreamChatViaClaudeOptions {
  readonly message: string;
  readonly systemPrompt: string;
  readonly resumeSessionId?: string | undefined;
  readonly cwd: string;
  /**
   * Awaited by the driver as soon as the SDK exposes a session id (which
   * happens after the first iteration of the async generator). The route's
   * SQLite upsert of `(prId, agent, headSha) → sessionId` therefore lands
   * before the stream closes, so a follow-up turn's `find()` reliably
   * sees the row and resumes instead of creating a fresh session.
   */
  readonly onSessionId?: ((id: string) => Promise<void> | void) | undefined;
  readonly abortController?: AbortController | undefined;
  readonly model?: string | undefined;
  /** Bound to the chat MCP server so its `get_review_context` tool can scope queries to the right PR. */
  readonly db: Db;
  readonly prId: string;
  /**
   * Authenticated user id from the chat session. Stamped on
   * `walkthroughs.lastEditedBy` when an edit tool fires via this driver.
   * Required for parity with the opencode HTTP MCP route which carries
   * the same identity via the token registry.
   */
  readonly userId: string;
  /**
   * When `false`, the SDK runs without `persistSession`. Used for one-shot
   * tasks like merge-conflict resolution that must NOT pollute the chat's
   * persisted session JSONL on disk. Defaults to `true` for the regular
   * chat flow.
   */
  readonly persistSession?: boolean | undefined;
  /**
   * When `false`, the in-process MCP server (`get_review_context`) is not
   * registered with the SDK. Useful for one-shot tasks (like conflict
   * resolution) where review context isn't relevant and we want a leaner
   * tool surface. Defaults to `true`.
   */
  readonly enableReviewContextMcp?: boolean | undefined;
  /**
   * Maximum number of agent turns within a single chat invocation.
   * Sourced from `UserSettings.aiMaxTurns`. Defaults to 60 when omitted.
   */
  readonly maxTurns?: number | undefined;
  /**
   * Session-level interaction toggle. When `'plan'`, the SDK runs in
   * `permissionMode: 'plan'` — the agent can investigate but cannot edit
   * or run commands; on completion it must call `ExitPlanMode` to surface
   * a plan for the user to approve.
   */
  readonly interactionMode?: InteractionMode | undefined;
}

// Tool-use blocks we surface as tool entries in the chat UI. Anything not in
// this set is silently consumed (e.g. system messages, telemetry tools).
// Note: TodoWrite / TaskCreate / TaskUpdate / TaskGet / TaskList, Agent, and
// ExitPlanMode have dedicated event paths and are NOT surfaced as plain
// activity entries — they route through the task-list / subagent-start /
// plan-presented frames.
const SURFACED_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "Write", "Edit", "Bash"]);

const CHAT_CONTEXT_MCP_SERVER = "revv-chat-context";
const CHAT_CONTEXT_MCP_PREFIX = `mcp__${CHAT_CONTEXT_MCP_SERVER}__`;

const EDIT_TOOL_NAMES_SET = new Set(EDIT_TOOL_SPECS.map((s) => s.name));

export function streamChatViaClaude(
  opts: StreamChatViaClaudeOptions,
): ReadableStream<RawChatStreamFrame> {
  const pinned = resolveCliBin("claude");
  const pathOption = pinned !== "claude" ? { pathToClaudeCodeExecutable: pinned } : {};

  return new ReadableStream<RawChatStreamFrame>({
    async start(controller) {
      // Track providerRequestIds (SDK toolUseIDs) for askUserQuestion
      // deferreds we've registered. Declared at stream scope so both the
      // `try` body and the `catch` cleanup branch can drain it. On
      // stream close/error we walk this set and reject anything still
      // pending so the SDK's `await canUseTool` Promise unwinds instead
      // of hanging.
      const pendingQuestionRequestIds = new Set<string>();
      // `hasEmittedText` + `lastWasNonText` insert a paragraph break
      // before any text-delta that follows a non-text event (tool
      // call, reasoning, error). Hoisted to stream scope so the
      // `canUseTool` callback (set up before walkClaudeMessages) can
      // reference `lastWasNonText` when it surfaces a question.
      let hasEmittedText = false;
      let lastWasNonText = false;
      try {
        // Build the options shape carefully — `resume` and `systemPrompt`
        // are mutually exclusive in practice (the SDK reattaches the prior
        // system message from the persisted JSONL on resume).
        // Scope the in-process MCP server to this PR so the
        // `get_review_context` tool returns issues + comments for the
        // right PR. Created per-call because the cwd / db / prId are
        // per-call too.
        const enableMcp = opts.enableReviewContextMcp ?? true;
        const planMode = opts.interactionMode === "plan";

        // emit + broadcastThreadEvent publish chat-edit walkthrough events
        // through `WalkthroughJobs.emitEvent` (CLAUDE.md invariant #7
        // carve-out, routed onto the global SSE bus) and `thread:*` events
        // through the global SSE bus. Both are fire-and-forget —
        // broadcast is best-effort per invariant #8.
        const emitWalkthroughEvent = (
          walkthroughId: string,
          event: WalkthroughStreamEvent,
        ): void => {
          void AppRuntime.runPromise(
            Effect.flatMap(WalkthroughJobs, (jobs) =>
              Effect.gen(function* () {
                yield* jobs.emitEvent(walkthroughId, {
                  type: "lifecycle:edited",
                  data: { walkthroughId, editedAt: new Date().toISOString() },
                });
                yield* jobs.emitEvent(walkthroughId, event);
              }),
            ),
          ).catch((err) => {
            logError(
              "chat-claude",
              "walkthrough:event emit failed:",
              err instanceof Error ? err.message : String(err),
            );
          });
          void AppRuntime.runPromise(
            Effect.flatMap(RemoteWalkthroughCache, (cache) =>
              cache.push(walkthroughId).pipe(Effect.catchAll(() => Effect.void)),
            ),
          ).catch((err) => {
            logError(
              "chat-claude",
              "remote cache push after edit failed:",
              err instanceof Error ? err.message : String(err),
            );
          });
        };
        const broadcastThreadEvent = (msg: ThreadEventMessage): void => {
          void AppRuntime.runPromise(
            Effect.gen(function* () {
              const prContext = yield* PrContextService;
              const repoService = yield* RepositoryService;
              const broadcaster = yield* Broadcaster;
              const { repo } = yield* prContext.resolveBasic(opts.prId, opts.userId);
              const accountId = yield* repoService.getAccountIdForRepo(repo.id);
              yield* broadcaster.broadcastToAccount(accountId, msg);
            }),
          ).catch((err) => {
            logError(
              "chat-claude",
              "thread broadcast failed:",
              err instanceof Error ? err.message : String(err),
            );
          });
        };

        const mcpServer = enableMcp
          ? createChatMcpServer({
              db: opts.db,
              prId: opts.prId,
              userId: opts.userId,
              actor: "chat:claude",
              emit: emitWalkthroughEvent,
              broadcastThreadEvent,
            })
          : null;

        // `Agent` enables sub-agent delegation (renamed from `Task` in
        // claude-agent-sdk 0.3.x — the old name no longer exists in the
        // SDK's tool surface). `TodoWrite` AND the `TaskCreate`/`TaskGet`/
        // `TaskUpdate`/`TaskList` family both enable the agent's own task
        // list; the SDK exposes both, the model picks based on its system
        // prompt, and the walker handles either surface. `ExitPlanMode`
        // is required for the SDK to terminate plan-mode cleanly;
        // `askUserQuestion` lets the agent surface a multiple-choice
        // prompt that we intercept via `canUseTool` (see below) and
        // resolve from the user's UI.
        const allowedTools = [
          "Read",
          "Grep",
          "Glob",
          "Write",
          "Edit",
          "Bash",
          "Agent",
          "TaskCreate",
          "TaskGet",
          "TaskUpdate",
          "TaskList",
          "TodoWrite",
          "ExitPlanMode",
          "askUserQuestion",
        ];
        if (enableMcp) {
          allowedTools.push(`${CHAT_CONTEXT_MCP_PREFIX}get_review_context`);
          // Walkthrough-edit tools are part of the same MCP server. In
          // plan mode we omit them so the agent can't mutate while
          // investigating; the agent must `ExitPlanMode` and the user
          // must approve before edits become available on the next turn.
          if (!planMode) {
            for (const name of EDIT_TOOL_NAMES_SET) {
              allowedTools.push(`${CHAT_CONTEXT_MCP_PREFIX}${name}`);
            }
          }
        }
        const canUseTool = async (
          toolName: string,
          input: Record<string, unknown>,
          ctx: {
            signal: AbortSignal;
            toolUseID: string;
          },
        ): Promise<PermissionResult> => {
          // Non-question tools: pass through. Outside this hook we set
          // `permissionMode: 'bypassPermissions'`, so this allow-path
          // reproduces the existing "no prompts mid-stream" semantics.
          if (toolName !== "askUserQuestion") {
            return { behavior: "allow", updatedInput: input };
          }
          const questions = normalizeClaudeAskUserQuestionInput(input);
          if (questions.length === 0) {
            // Malformed input — deny with a structured failure the
            // model can recover from instead of hanging on a question
            // we can't render.
            return {
              behavior: "deny",
              message:
                "askUserQuestion: empty or malformed question payload — re-issue with valid questions/options.",
              interrupt: false,
            };
          }
          const providerRequestId = ctx.toolUseID;
          pendingQuestionRequestIds.add(providerRequestId);

          // Emit the raw frame so the persistence wrapper assigns a
          // questionId, writes a chat_questions row, and forwards the
          // wire frame to the web client.
          controller.enqueue({
            kind: "user-question",
            providerRequestId,
            questions,
            previewFormat: "markdown",
          });
          lastWasNonText = true;

          return new Promise<PermissionResult>((resolve, reject) => {
            const onAbort = (): void => {
              pendingQuestionRequestIds.delete(providerRequestId);
              reject(new Error("askUserQuestion: aborted"));
            };
            if (ctx.signal.aborted) {
              onAbort();
              return;
            }
            ctx.signal.addEventListener("abort", onAbort, {
              once: true,
            });
            registerPendingQuestion(providerRequestId, {
              resolve: (result) => {
                ctx.signal.removeEventListener("abort", onAbort);
                pendingQuestionRequestIds.delete(providerRequestId);
                resolve(result);
              },
              reject: (err) => {
                ctx.signal.removeEventListener("abort", onAbort);
                pendingQuestionRequestIds.delete(providerRequestId);
                reject(err);
              },
            });
          });
        };

        const queryOpts: Record<string, unknown> = {
          cwd: opts.cwd,
          allowedTools,
          ...(mcpServer ? { mcpServers: { [CHAT_CONTEXT_MCP_SERVER]: mcpServer } } : {}),
          // Per-tool configuration for built-in tools. We request the
          // markdown previewFormat so the SDK instructs the model to
          // emit `preview` fields as markdown — the chat UI renders
          // them via the same Markdown pipeline as message bodies.
          toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
          // `canUseTool` intercepts `askUserQuestion` and returns a
          // Promise resolved by the answer endpoint. All other tools
          // fall through to `{ behavior: 'allow' }` which preserves
          // the existing bypass semantics.
          canUseTool,
          // In plan mode we trade permission bypass for `permissionMode:
          // 'plan'`. The agent can investigate but cannot mutate the
          // worktree; it must call `ExitPlanMode` to surface a plan for
          // approval. Outside plan mode we keep the existing
          // `bypassPermissions` shape so the chat flow doesn't gain
          // per-tool permission prompts mid-stream.
          //
          // Note: setting `canUseTool` overrides `permissionMode`
          // behavior only for tools the callback inspects. Built-in
          // permissions outside `askUserQuestion` still respect
          // `bypassPermissions`.
          permissionMode: planMode ? "plan" : "bypassPermissions",
          ...(planMode ? {} : { allowDangerouslySkipPermissions: true }),
          persistSession: opts.persistSession ?? true,
          maxTurns: opts.maxTurns ?? 60,
          // Opt into per-token streaming. Without this, the SDK only
          // emits a single `assistant` message at the end of each
          // turn containing the whole response as one or two
          // content blocks — the chat bubble would receive the full
          // answer as one big chunk. With it on, the walker also
          // sees `stream_event` messages with `content_block_delta`
          // events at the model's natural token cadence, producing
          // a fluid typewriter-style stream. The walker dedups
          // against the trailing `assistant` message so we don't
          // double-emit.
          includePartialMessages: true,
          ...pathOption,
        };

        if (opts.resumeSessionId) {
          queryOpts.resume = opts.resumeSessionId;
        } else {
          queryOpts.systemPrompt = opts.systemPrompt;
        }

        if (opts.abortController) {
          queryOpts.abortController = opts.abortController;
        }
        if (opts.model) {
          queryOpts.model = opts.model;
        }

        const q = query({
          prompt: opts.message,
          options: queryOpts,
        });

        let sessionIdReported = false;
        const tryReportSessionId = async (): Promise<void> => {
          if (sessionIdReported || !opts.onSessionId) return;
          let sid: string | undefined;
          try {
            sid = (q as { sessionId?: string }).sessionId;
          } catch {
            // `q.sessionId` getter throws before the session is
            // initialized — keep trying on later iterations.
            return;
          }
          if (typeof sid === "string" && sid.length > 0) {
            // Mark first so concurrent calls (the post-loop "last
            // chance") don't fire the callback twice.
            sessionIdReported = true;
            // Awaited: SQLite upsert in the route handler must
            // commit before the stream closes so a follow-up turn
            // can resume this session.
            await opts.onSessionId(sid);
          }
        };

        // Map normalized events → ChatStreamFrame. Reasoning is surfaced
        // to chat (the panel renders a thinking indicator while it's
        // streaming); walkthrough drops it on the floor (separate
        // caller). Tool-call → activity, filtered by `SURFACED_TOOLS`
        // for built-ins or the chat-context MCP server name for MCP.
        //
        // `hasEmittedText` + `lastWasNonText` insert a paragraph break
        // before any text-delta that follows a non-text event (tool
        // call, reasoning, error). Without this, Claude's content
        // blocks ("Now let me check:", tool_use, "Clear picture.")
        // get concatenated into "Now let me check:Clear picture." in
        // the assistant bubble because text-deltas are appended via
        // `||`. The separator lands in both the streamed frame and
        // the persisted content, so reloads also render correctly.
        // (Declarations hoisted to stream scope above.)
        const emit = (ev: import("../agent-stream").NormalizedAgentEvent): void => {
          if (ev.kind === "text-delta") {
            const needsSeparator = hasEmittedText && lastWasNonText && !ev.data.startsWith("\n");
            const data = needsSeparator ? `\n\n${ev.data}` : ev.data;
            controller.enqueue({ kind: "text", data });
            hasEmittedText = true;
            lastWasNonText = false;
          } else if (ev.kind === "reasoning-delta") {
            controller.enqueue({ kind: "reasoning", data: ev.data });
            lastWasNonText = true;
          } else if (ev.kind === "tool-call") {
            if (ev.source === "builtin") {
              // askUserQuestion fires its own normalized event from
              // the canUseTool path — skip its post-hoc tool_use
              // block so the UI doesn't see a duplicate row.
              if (ev.toolName === "askUserQuestion") return;
              if (!SURFACED_TOOLS.has(ev.toolName)) return;
              const activity = buildActivity(ev.toolName, ev.input);
              const frame = ev.subagentProviderCallId
                ? {
                    kind: "activity" as const,
                    ...activity,
                    subagentProviderCallId: ev.subagentProviderCallId,
                  }
                : { kind: "activity" as const, ...activity };
              controller.enqueue(frame);
              lastWasNonText = true;
            } else if (ev.source === "mcp" && ev.mcpServer === CHAT_CONTEXT_MCP_SERVER) {
              const base = {
                kind: "activity" as const,
                activityKind: "tool.mcp" as const,
                toolName: ev.toolName,
                summary: `Looking up review context (${ev.bareName})`,
                ...(ev.input !== undefined ? { payload: ev.input } : {}),
              };
              controller.enqueue(
                ev.subagentProviderCallId
                  ? { ...base, subagentProviderCallId: ev.subagentProviderCallId }
                  : base,
              );
              lastWasNonText = true;
            }
          } else if (ev.kind === "task-list-update") {
            controller.enqueue({
              kind: "task-list",
              tasks: ev.tasks,
            });
            lastWasNonText = true;
          } else if (ev.kind === "plan-presented") {
            controller.enqueue({
              kind: "plan-presented",
              providerPlanId: ev.providerPlanId,
              markdown: ev.markdown,
            });
            lastWasNonText = true;
          } else if (ev.kind === "subagent-start") {
            controller.enqueue({
              kind: "subagent-start",
              providerCallId: ev.providerCallId,
              subagentType: ev.subagentType,
              description: ev.description,
              prompt: ev.prompt,
            });
            lastWasNonText = true;
          } else if (ev.kind === "subagent-end") {
            controller.enqueue({
              kind: "subagent-end",
              providerCallId: ev.providerCallId,
              result: ev.result,
              ok: ev.ok,
            });
            lastWasNonText = true;
          } else if (ev.kind === "user-question-asked") {
            // Claude path emits this from `canUseTool` directly via
            // `controller.enqueue` (see above) — walkClaudeMessages
            // never emits one. This branch exists for completeness
            // in case a future code path routes through emit().
            controller.enqueue({
              kind: "user-question",
              providerRequestId: ev.providerRequestId,
              questions: ev.questions,
              previewFormat: ev.previewFormat,
              ...(ev.providerToolCallId ? { providerToolCallId: ev.providerToolCallId } : {}),
            });
            lastWasNonText = true;
          } else if (ev.kind === "user-question-resolved") {
            // Claude doesn't emit this — its resolution lives inside
            // the answer endpoint. No-op for parity.
          } else if (ev.kind === "error") {
            controller.enqueue({ kind: "text", data: `\n\n_Error: ${ev.message}_` });
            hasEmittedText = true;
            lastWasNonText = false;
          }
        };

        // `fluidEmit` splits any oversized text/reasoning delta into
        // smaller word-aligned chunks before the bubble updates, so a
        // burst-delivered paragraph renders as a typewriter trickle
        // instead of one big dump. Short deltas (the common case once
        // `includePartialMessages: true` is on) pass straight through.
        await walkClaudeMessages(q, fluidEmit(emit), {
          onMessage: tryReportSessionId,
        });

        // Last chance to grab the session id — some early aborts never
        // emit an assistant message.
        await tryReportSessionId();
        // Reject any askUserQuestion deferreds that never received an
        // answer. The model's turn is over (or aborting); leaving them
        // pending would cause `await canUseTool` to hang any in-flight
        // callbacks the SDK hasn't yet awaited. Best-effort — these
        // rows are already terminal in the model's view.
        for (const id of pendingQuestionRequestIds) {
          const deferred = takePendingQuestion(id);
          deferred?.reject(new Error("stream closed before answer"));
        }
        pendingQuestionRequestIds.clear();
        controller.close();
      } catch (err) {
        for (const id of pendingQuestionRequestIds) {
          const deferred = takePendingQuestion(id);
          deferred?.reject(new Error("stream errored before answer"));
        }
        pendingQuestionRequestIds.clear();
        controller.error(new AiGenerationError({ cause: err }));
      }
    },
  });
}
