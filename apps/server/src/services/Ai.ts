import type { ChatAttachment, InteractionMode } from "@revv/shared";
import { SPAN_ATTR } from "@revv/shared/telemetry";
import { Context, Effect, Layer } from "effect";
import { type AgentLaunch, resolveAgentLaunch } from "../ai/acp/agent-launch";
import { isAgentLaunchable } from "../ai/acp/launch";
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
import { streamChatViaAcp } from "../ai/providers/chat-acp";
import { CHAT_TOOL_BUNDLE } from "../ai/providers/chat-mcp-tools";
import type { RawChatStreamFrame } from "../ai/providers/chat-types";
import { turnMcpServer } from "../ai/providers/mcp-tool-gateway";
import {
  runWalkthroughTurn,
  type WalkthroughTurnParams,
  type WalkthroughTurnResult,
} from "../ai/providers/walkthrough-acp";
import { type AiError, AiNotConfiguredError } from "../domain/errors";
import { ChatMcpTokens } from "./chat/ChatMcpTokens";
import { SettingsService } from "./Settings";

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
  readonly abortController?: AbortController;
  /** Session-level interaction toggle; `plan` switches the agent into its plan mode. Defaults to `'default'`. */
  readonly interactionMode?: InteractionMode;
}

export class AiService extends Context.Service<
  AiService,
  {
    readonly walkthroughTurn: (
      params: WalkthroughTurnParams,
    ) => Effect.Effect<WalkthroughTurnResult, AiError>;
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

export const AiServiceLive = Layer.effect(
  AiService,
  Effect.gen(function* () {
    const settingsService = yield* SettingsService;
    const chatMcpTokens = yield* ChatMcpTokens;
    const withSettings = Effect.provideService(SettingsService, settingsService);

    const requireLaunchable = (launch: AgentLaunch): Effect.Effect<void, AiError> =>
      isAgentLaunchable(launch.agent) ? Effect.void : Effect.fail(new AiNotConfiguredError());

    return {
      walkthroughTurn: (params) =>
        Effect.withSpan("Ai.walkthroughTurn", {
          attributes: {
            [SPAN_ATTR.walkthroughId]: params.walkthroughId,
            [SPAN_ATTR.provider]: params.launch.agent,
            [SPAN_ATTR.model]: params.launch.model,
          },
        })(
          Effect.gen(function* () {
            const result = yield* Effect.promise(() => runWalkthroughTurn(params));
            if ("notConfigured" in result) return yield* Effect.fail(new AiNotConfiguredError());
            return result;
          }),
        ),

      chat: (params: ChatParams) =>
        Effect.withSpan("Ai.chat")(
          Effect.gen(function* () {
            const { launch } = params;
            yield* Effect.annotateCurrentSpan(SPAN_ATTR.prId, params.prId);
            yield* Effect.annotateCurrentSpan(SPAN_ATTR.provider, "acp");
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
              mcp: turnMcpServer(CHAT_TOOL_BUNDLE, params.prId, token, false),
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
