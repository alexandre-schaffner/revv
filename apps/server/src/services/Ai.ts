import type {
  ChatAttachment,
  InteractionMode,
  WalkthroughMode,
  WalkthroughStreamEvent,
} from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import { type AgentLaunch, resolveAgentLaunch } from "../ai/acp/agent-launch";
import { isAgentLaunchable } from "../ai/acp/launch";
import type { ActivityBeacon } from "../ai/acp/run-turn";
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
import { CHAT_TOOL_BUNDLE } from "../ai/providers/chat-mcp-tools";
import type { RawChatStreamFrame } from "../ai/providers/chat-types";
import { guardWalkthroughStream } from "../ai/providers/stream-guard";
import { streamWalkthroughViaAcp } from "../ai/providers/walkthrough-acp";
import { type AiError, AiNotConfiguredError } from "../domain/errors";
import { ChatMcpTokens } from "./ChatMcpTokens";
import { DbService } from "./Db";
import type { PrFileMeta } from "./GitHub";
import { SettingsService } from "./Settings";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatParams {
  /** The chat launch the session row is keyed on (`resolveAgentLaunch("chat")`). */
  readonly launch: AgentLaunch;
  readonly pr: ChatPrContext;
  readonly walkthrough: ChatWalkthroughContext | null;
  readonly message: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  /**
   * The session's timeline before this message, inlined into the prompt when
   * the agent session is fresh (never resumed, or no longer loadable).
   */
  readonly history: ReadonlyArray<ChatHistoryEntry>;
  readonly cwd: string;
  readonly branchName: string;
  readonly resumeSessionId: string | null;
  /**
   * Reports a fresh agent session id for `chat_sessions`. Awaited before the
   * prompt, so a follow-up turn can't race the write and open a second session.
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
    /** One right-pane chat turn on `params.launch`, streamed as chat frames. */
    readonly chat: (
      params: ChatParams,
    ) => Effect.Effect<ReadableStream<RawChatStreamFrame>, AiError>;
    /**
     * A one-shot agent run against `cwd`, a worktree with a merge or rebase
     * paused on conflicts. Its prompt allows `--continue` but forbids push,
     * amend and abort. Not part of the chat conversation: nothing is persisted
     * and it gets no Revv MCP tools.
     */
    readonly resolveMergeConflict: (params: {
      readonly cwd: string;
      readonly task: ResolveConflictsTask;
      readonly conflictFiles: ReadonlyArray<string>;
      readonly abortController?: AbortController | undefined;
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
    const withSettings = Effect.provideService(SettingsService, settingsService);

    const requireLaunchable = (launch: AgentLaunch): Effect.Effect<void, AiError> =>
      isAgentLaunchable(launch.agent) ? Effect.void : Effect.fail(new AiNotConfiguredError());

    return {
      streamWalkthrough: (params) =>
        Effect.withSpan("Ai.streamWalkthrough", {
          attributes: { walkthroughId: params.walkthroughId },
        })(
          Effect.gen(function* () {
            const launch = yield* withSettings(
              resolveAgentLaunch("review", params.launchOverride ?? null),
            );
            yield* Effect.annotateCurrentSpan("provider", launch.agent);
            yield* Effect.annotateCurrentSpan("model", launch.model);
            yield* requireLaunchable(launch);
            const raw = streamWalkthroughViaAcp({ ...params, db, launch });
            return guardWalkthroughStream(raw, { label: "walkthrough-acp" });
          }),
        ),

      chat: (params: ChatParams) =>
        Effect.withSpan("Ai.chat")(
          Effect.gen(function* () {
            const { launch } = params;
            yield* Effect.annotateCurrentSpan("prId", params.prId);
            yield* Effect.annotateCurrentSpan("provider", "acp");
            yield* Effect.annotateCurrentSpan("agent", launch.agent);
            yield* requireLaunchable(launch);

            const systemPrompt = buildChatSystemPrompt({
              pr: params.pr,
              walkthrough: params.walkthrough,
              branchName: params.branchName,
            });
            const interactionMode = params.interactionMode ?? "default";
            const token = yield* chatMcpTokens.issue({
              prId: params.prId,
              userId: params.userId,
              interactionMode,
            });

            return streamChatViaAcp({
              launch,
              cwd: params.cwd,
              message: params.message,
              // A resumed session already has the system prompt and the
              // transcript; sending them again makes the agent echo them.
              promptText: (fresh) =>
                fresh
                  ? `${systemPrompt}\n\n---\n\n${buildChatUserMessage({ message: params.message, history: params.history })}`
                  : params.message,
              attachments: params.attachments,
              resumeSessionId: params.resumeSessionId,
              onSessionId: params.onSessionId,
              mcp: {
                route: "/mcp/chat-context",
                name: `${CHAT_TOOL_BUNDLE.name}-${params.prId}`,
                token,
                required: false,
              },
              interactionMode,
              abortController: params.abortController,
              onFinished: () => Effect.runSync(chatMcpTokens.clear(token)),
            });
          }),
        ),

      resolveMergeConflict: (params) =>
        Effect.gen(function* () {
          const launch = yield* withSettings(resolveAgentLaunch("chat"));
          yield* requireLaunchable(launch);
          const systemPrompt = buildResolveConflictsPrompt(params.task, params.conflictFiles);
          const message = buildResolveConflictsUserMessage(params.task);
          return streamChatViaAcp({
            launch,
            cwd: params.cwd,
            message,
            promptText: () => `${systemPrompt}\n\n---\n\n${message}`,
            abortController: params.abortController,
          });
        }),

      isConfigured: () =>
        Effect.map(settingsService.resolveAgent(), (agent) => isAgentLaunchable(agent)),
    };
  }),
);
