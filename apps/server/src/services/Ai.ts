import type {
  ChatAttachment,
  InteractionMode,
  WalkthroughMode,
  WalkthroughStreamEvent,
} from "@revv/shared";
import { resolveThinkingEffort } from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import { isAcpAgentAvailable, resolveGenerationModel } from "../ai/acp/presets";
import type { ActivityBeacon } from "../ai/agent-stream";
import type { GenerationLaunchOverride } from "../ai/jev/routing";
import {
  buildChatSystemPrompt,
  buildChatUserMessage,
  buildResolveConflictsPrompt,
  buildResolveConflictsUserMessage,
  type ChatHistoryEntry,
  type ChatPrContext,
  type ChatWalkthroughContext,
  type ResolveConflictsTask,
} from "../ai/prompts/chat";
import type { WalkthroughPromptHints, WalkthroughReviewMode } from "../ai/prompts/walkthrough";
import { streamChatViaAcp } from "../ai/providers/chat-acp";
import type { RawChatStreamFrame } from "../ai/providers/chat-types";
import { guardWalkthroughStream } from "../ai/providers/stream-guard";
import { streamWalkthroughViaAcp } from "../ai/providers/walkthrough-acp";
import { type AiError, AiNotConfiguredError } from "../domain/errors";
import { ChatMcpTokens } from "./ChatMcpTokens";
import { DbService } from "./Db";
import type { PrFileMeta } from "./github/pulls";
import { SettingsService } from "./Settings";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatParams {
  readonly pr: ChatPrContext;
  readonly walkthrough: ChatWalkthroughContext | null;
  readonly message: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  /**
   * Persisted chat timeline (messages + activities) for the current
   * session, NOT including the message being sent in this turn. The chat
   * route fetches this from `chat_messages` / `chat_activities` before
   * appending the new user message and passes it through so the prompt
   * builder can inline a `## Conversation history` block. This keeps the
   * agent in-context even when native session resume is unavailable.
   */
  readonly history: ReadonlyArray<ChatHistoryEntry>;
  readonly cwd: string;
  readonly branchName: string;
  readonly resumeSessionId: string | null;
  /**
   * Reports a fresh ACP session id back to the chat route so it can persist it
   * in `chat_sessions`. The driver awaits it before prompting, which closes the
   * race where a follow-up turn arrives before the write commits and opens a
   * second agent session.
   */
  readonly onSessionId: (id: string) => Promise<void> | void;
  readonly prId: string;
  /** Authenticated user id from the chat session, carried in the chat MCP token. */
  readonly userId: string;
  readonly abortController?: AbortController;
  /** Session-level interaction toggle; `plan` switches the agent into its plan mode. Defaults to `'default'`. */
  readonly interactionMode?: InteractionMode;
}

// ── Service definition ───────────────────────────────────────────────────────

export class AiService extends Context.Service<
  AiService,
  {
    readonly streamWalkthrough: (
      params: {
        /** Issued by WalkthroughJobs (`createPartial`) before the agent spawns; every MCP write is scoped to it. */
        walkthroughId: string;
        pr: {
          title: string;
          body: string | null;
          sourceBranch: string;
          targetBranch: string;
          url: string;
        };
        mode: WalkthroughMode;
        files: PrFileMeta[];
        worktreePath: string;
        reviewMode: WalkthroughReviewMode;
        resumed: boolean;
        mcpToken: string;
        activity: ActivityBeacon;
        abortController: AbortController;
        /**
         * Per-job model/effort override, resolved once at job start. Absent
         * uses configured settings. Goes through `resolveGenerationModel` so
         * an override naming a model this agent can't run falls back safely.
         */
        launchOverride?: GenerationLaunchOverride;
      } & WalkthroughPromptHints,
    ) => Effect.Effect<AsyncGenerator<WalkthroughStreamEvent>, AiError>;
    /**
     * Stream a single chat turn for the right-pane chat. Resolves the
     * configured agent, builds the system prompt + user message, and hands
     * off to the ACP driver. The returned stream emits both text deltas and
     * tool-use lines so the UI can render the agent's actions inline.
     *
     * The ACP session lifecycle is owned by the caller (the chat route) —
     * this method just wires `resumeSessionId` and `onSessionId` through.
     */
    readonly chat: (
      params: ChatParams,
    ) => Effect.Effect<ReadableStream<RawChatStreamFrame>, AiError>;
    /**
     * One-shot agent invocation for resolving conflicts. Runs the
     * configured CLI agent against `cwd` (a worktree with a merge or rebase
     * paused on conflicts) with a `task`-specific system prompt that ALLOWS
     * `git merge --continue` / `git rebase --continue` but forbids push /
     * amend / abort. Does NOT persist the session —
     * this is not part of the chat conversation, and we don't want it to
     * pollute the session JSONL or `chat_messages` history.
     */
    readonly resolveMergeConflict: (params: {
      readonly cwd: string;
      readonly task: ResolveConflictsTask;
      readonly conflictFiles: ReadonlyArray<string>;
      readonly abortController?: AbortController | undefined;
      readonly prId: string;
      readonly userId: string;
    }) => Effect.Effect<ReadableStream<RawChatStreamFrame>, AiError>;
    readonly isConfigured: () => Effect.Effect<boolean>;
  }
>()("AiService") {}

// ── Live implementation ──────────────────────────────────────────────────────

export const AiServiceLive = Layer.effect(
  AiService,
  Effect.gen(function* () {
    const settingsService = yield* SettingsService;
    const { db } = yield* DbService;
    const chatMcpTokens = yield* ChatMcpTokens;

    // Whether the resolved agent's ACP launch command is available.
    const checkConfigured = (): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const agent = yield* settingsService.resolveAgent();
        return isAcpAgentAvailable(agent);
      });

    return {
      streamWalkthrough: (params) =>
        Effect.withSpan("Ai.streamWalkthrough", {
          attributes: { walkthroughId: params.walkthroughId },
        })(
          Effect.gen(function* () {
            const settings = yield* settingsService.getSettings();
            const agent = yield* settingsService.resolveAgent();

            // KPI telemetry: label the span with the resolved provider + model.
            yield* Effect.annotateCurrentSpan("provider", agent);
            if (settings.aiModel) yield* Effect.annotateCurrentSpan("model", settings.aiModel);

            if (!isAcpAgentAvailable(agent)) {
              return yield* Effect.fail(new AiNotConfiguredError());
            }

            // Guard against a chat-only agent id left over from the bottom bar (e.g. cursor).
            const override = params.launchOverride;
            const model = resolveGenerationModel(agent, override?.model ?? settings.aiModel);
            const raw = streamWalkthroughViaAcp(
              { ...params, db, acpAgentId: agent },
              {
                model,
                // Sized effort for Auto, the user's pin otherwise.
                thinkingEffort: resolveThinkingEffort(
                  settings.aiThinkingEffort,
                  override?.thinkingEffort ?? null,
                ),
              },
            );
            return guardWalkthroughStream(raw, { label: "walkthrough-acp" });
          }),
        ),

      chat: (params: ChatParams) =>
        Effect.withSpan("Ai.chat")(
          Effect.gen(function* () {
            const settings = yield* settingsService.getSettings();
            const acpAgentId = yield* settingsService.resolveAgent();
            yield* Effect.annotateCurrentSpan("prId", params.prId);
            yield* Effect.annotateCurrentSpan("provider", "acp");
            yield* Effect.annotateCurrentSpan("agent", acpAgentId);

            // Availability is the ACP command's, not a per-agent CLI's.
            if (!isAcpAgentAvailable(acpAgentId)) {
              return yield* Effect.fail(new AiNotConfiguredError());
            }

            const systemPrompt = buildChatSystemPrompt({
              pr: params.pr,
              walkthrough: params.walkthrough,
              branchName: params.branchName,
            });
            // Only inline the `## Conversation history` block on a fresh
            // session (no resume id). On resume the agent already has the prior
            // turns in its own (disk-persisted) session state; sending the
            // transcript again makes the agent echo it back into its response.
            const message = params.resumeSessionId
              ? params.message
              : buildChatUserMessage({
                  message: params.message,
                  history: params.history,
                });

            return streamChatViaAcp({
              message,
              attachments: params.attachments,
              systemPrompt,
              resumeSessionId: params.resumeSessionId ?? undefined,
              cwd: params.cwd,
              onSessionId: params.onSessionId,
              abortController: params.abortController,
              model: resolveGenerationModel(acpAgentId, settings.aiModel),
              thinkingEffort: resolveThinkingEffort(settings.aiThinkingEffort),
              acpAgentId,
              deps: {
                issueChatMcpToken: (args) => Effect.runPromise(chatMcpTokens.issue(args)),
                clearChatMcpToken: (token: string) => Effect.runPromise(chatMcpTokens.clear(token)),
              },
              prId: params.prId,
              userId: params.userId,
              interactionMode: params.interactionMode,
            });
          }),
        ),

      resolveMergeConflict: (params) =>
        Effect.gen(function* () {
          const settings = yield* settingsService.getSettings();
          const acpAgentId = yield* settingsService.resolveAgent();

          if (!isAcpAgentAvailable(acpAgentId)) {
            return yield* Effect.fail(new AiNotConfiguredError());
          }

          const systemPrompt = buildResolveConflictsPrompt(params.task, params.conflictFiles);
          const message = buildResolveConflictsUserMessage(params.task);

          // ACP transport: one-shot, no resume, no review-context MCP. The
          // system prompt forbids push/amend/abort (auto-allow keeps that
          // restriction prompt-level).
          return streamChatViaAcp({
            message,
            systemPrompt,
            resumeSessionId: undefined,
            cwd: params.cwd,
            onSessionId: undefined,
            abortController: params.abortController,
            model: resolveGenerationModel(acpAgentId, settings.aiModel),
            thinkingEffort: resolveThinkingEffort(settings.aiThinkingEffort),
            acpAgentId,
            deps: {
              issueChatMcpToken: (args) => Effect.runPromise(chatMcpTokens.issue(args)),
              clearChatMcpToken: (token: string) => Effect.runPromise(chatMcpTokens.clear(token)),
            },
            prId: params.prId,
            userId: params.userId,
            enableReviewContextMcp: false,
          });
        }),

      isConfigured: () => checkConfigured(),
    };
  }),
);
