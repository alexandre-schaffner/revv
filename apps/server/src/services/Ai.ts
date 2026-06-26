import type {
  ChatAttachment,
  InteractionMode,
  WalkthroughMode,
  WalkthroughStreamEvent,
} from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import {
  applyAcpAgentOverride,
  isAcpAgentAvailable,
  resolveGenerationModel,
} from "../ai/acp/presets";
import {
  buildChatSystemPrompt,
  buildChatUserMessage,
  buildResolveConflictsPrompt,
  buildResolveConflictsUserMessage,
  type ChatHistoryEntry,
  type ChatPrContext,
  type ChatWalkthroughContext,
} from "../ai/prompts/chat";
import { streamChatViaAcp } from "../ai/providers/chat-acp";
import type { RawChatStreamFrame } from "../ai/providers/chat-types";
// ── Prompt & provider imports (split out of this file) ──────────────────────
import { guardWalkthroughStream } from "../ai/providers/stream-guard";
import { type ContinuationContext, streamWalkthroughViaAcp } from "../ai/providers/walkthrough-acp";
import {
  type AiError,
  AiGenerationError,
  AiNotConfiguredError,
  type ValidationError,
} from "../domain/errors";
import { withDb } from "../effects/with-db";
import { ChatMcpTokens } from "./ChatMcpTokens";
import { DbService } from "./Db";
import type { PrFileMeta } from "./GitHub";
import { SettingsService } from "./Settings";

// ── Types ────────────────────────────────────────────────────────────────────

export type { ContinuationContext };

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
   * Reports the agent-side session id back to the chat route so it can
   * persist `(prId, agent, prHeadSha) → sessionId` in `chat_sessions`.
   * Drivers MUST await this before streaming user-visible content
   * (opencode path, where the id is known up front) or before closing
   * their stream (claude path, where the id arrives after the first SDK
   * iteration). Awaiting closes the race where a follow-up turn arrives
   * before the upsert commits and creates a fresh agent session.
   */
  readonly onSessionId: (id: string) => Promise<void> | void;
  readonly prId: string;
  /**
   * Authenticated user id from the chat session. Stamped on
   * `walkthroughs.lastEditedBy` when an edit tool fires; also carried in
   * the opencode MCP token registry.
   */
  readonly userId: string;
  readonly abortController?: AbortController;
  /**
   * Session-level interaction toggle. Both drivers honor this: Claude flips
   * to `permissionMode: 'plan'`; opencode routes through its named `plan`
   * agent. Defaults to `'default'`.
   */
  readonly interactionMode?: InteractionMode;
}

// ── Service definition ───────────────────────────────────────────────────────

export class AiService extends Context.Tag("AiService")<
  AiService,
  {
    readonly streamWalkthrough: (params: {
      /**
       * The deterministic walkthrough id the MCP tool handlers will scope
       * all writes to. Issued by {@link WalkthroughJobs.startJob} via
       * `walkthroughService.createPartial` BEFORE the provider is spawned.
       * The providers inject this into the shared tool-handler context
       * (doctrine invariant #11 — identity is orchestrator-provided).
       */
      walkthroughId: string;
      /**
       * Account that owns the PR. Passed through to the Claude MCP provider
       * so it can scope SSE broadcasts without re-deriving accountId via a
       * DB join on every tool call.
       */
      accountId: string;
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
      continuation?: ContinuationContext;
      onSessionId?: (sessionId: string) => void;
      /**
       * Optional caller-owned abort controller. When provided, it is
       * forwarded to the underlying provider so external cancellation
       * (regenerate, scope close, shutdown) propagates straight into the
       * Claude Agent SDK turn or the opencode HTTP session.
       */
      abortController?: AbortController;
      /**
       * Optional caller-provided callbacks for minting + clearing the
       * HTTP-MCP session token. Only consulted when the resolved agent uses
       * the HTTP MCP transport; the Claude SDK path ignores them.
       * WalkthroughJobs supplies these because it owns the session-token
       * map (in-process, ephemeral per invariant #1). Kept as plain
       * callbacks so AiService doesn't need a layer dependency on
       * WalkthroughJobs (that would cycle — WalkthroughJobs depends on
       * AiService already).
       */
      issueHttpMcpSessionToken?: (walkthroughId: string) => Promise<string>;
      clearHttpMcpSessionToken?: (token: string) => Promise<void>;
      registerHttpMcpActivityNotifier?: (
        walkthroughId: string,
        callback: (event: WalkthroughStreamEvent) => void,
      ) => Promise<void>;
      unregisterHttpMcpActivityNotifier?: (walkthroughId: string) => Promise<void>;
    }) => Effect.Effect<AsyncGenerator<WalkthroughStreamEvent>, AiError>;
    /**
     * Stream a single chat turn for the right-pane chat. Resolves the
     * configured agent, builds the system prompt + user message, and hands
     * off to the provider. The returned stream emits both text deltas and
     * tool-use lines so the UI can render the agent's actions inline.
     *
     * Session lifecycle (claude `resume:` / opencode session id) is owned
     * by the caller (the chat route) — this method just wires the
     * `resumeSessionId` and `onSessionId` callback through.
     */
    readonly chat: (
      params: ChatParams,
    ) => Effect.Effect<ReadableStream<RawChatStreamFrame>, AiError>;
    /**
     * One-shot agent invocation for resolving merge conflicts. Runs the
     * configured CLI agent against `cwd` (an in-progress merge worktree)
     * with a dedicated system prompt that ALLOWS `git merge --continue`
     * but forbids push / amend / abort. Does NOT persist the session —
     * this is not part of the chat conversation, and we don't want it to
     * pollute the session JSONL or `chat_messages` history.
     */
    readonly resolveMergeConflict: (params: {
      readonly cwd: string;
      readonly agentBranch: string;
      readonly sourceBranch: string;
      readonly conflictFiles: ReadonlyArray<string>;
      readonly abortController?: AbortController | undefined;
      /**
       * Optional PR id used by the opencode chat MCP server to scope its
       * tools. Conflict resolution doesn't actually need review context
       * but the opencode driver requires the param to mint its bearer
       * token. Pass an empty string for paths where it doesn't matter.
       */
      readonly prId: string;
      /**
       * User id from the calling session. Threaded through to the MCP
       * server even though the conflict-resolve agent never calls the
       * edit tools (its allowed-tools list doesn't include them).
       */
      readonly userId: string;
    }) => Effect.Effect<ReadableStream<RawChatStreamFrame>, AiError>;
    readonly isConfigured: () => Effect.Effect<boolean>;
  }
>() {}

// ── Live implementation ──────────────────────────────────────────────────────

export const AiServiceLive = Layer.effect(
  AiService,
  Effect.gen(function* () {
    const settingsService = yield* SettingsService;
    const { db } = yield* DbService;
    // Every AI pipeline — chat, merge-conflict, walkthrough, recap, and
    // suggestions — runs on the ACP transport now. There is no opencode daemon
    // or provider SDK left to manage.
    const chatMcpTokens = yield* ChatMcpTokens;

    // Map ValidationError from getSettings() to AiGenerationError
    const getSettings = () =>
      withDb(db, settingsService.getSettings()).pipe(
        Effect.mapError(
          (e: ValidationError) =>
            new AiGenerationError({ cause: e, message: e.message }) as AiError,
        ),
      );
    const getAgent = () =>
      withDb(db, settingsService.resolveAgent()).pipe(
        Effect.mapError(
          (e: ValidationError) =>
            new AiGenerationError({ cause: e, message: e.message }) as AiError,
        ),
      );

    // Whether the resolved agent's ACP launch command is available.
    const checkConfigured = (): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const agent = yield* getAgent();
        return isAcpAgentAvailable(agent);
      }).pipe(Effect.catchAll(() => Effect.succeed(false)));

    return {
      streamWalkthrough: (params) =>
        Effect.withSpan("Ai.streamWalkthrough", {
          attributes: { walkthroughId: params.walkthroughId },
        })(
          Effect.gen(function* () {
            const settings = yield* getSettings();
            const agent = yield* getAgent();

            // Walkthrough generation runs exclusively on the ACP transport now.
            // The shared MCP tool handlers behind `/mcp/walkthrough` are the same
            // code every agent reaches (doctrine invariant #13 — agent-path parity).
            const acpAgentId = agent;
            if (!isAcpAgentAvailable(acpAgentId)) {
              return yield* Effect.fail(new AiNotConfiguredError());
            }

            // HTTP-MCP callbacks are MANDATORY for every walkthrough now (there
            // is no in-process path). WalkthroughJobs always supplies them.
            if (
              !params.issueHttpMcpSessionToken ||
              !params.clearHttpMcpSessionToken ||
              !params.registerHttpMcpActivityNotifier ||
              !params.unregisterHttpMcpActivityNotifier
            ) {
              return yield* Effect.fail(
                new AiGenerationError({
                  cause: new Error("missing HTTP-MCP callbacks"),
                  message:
                    "walkthrough generation requires caller-supplied HTTP-MCP session-token + activity-notifier callbacks",
                }),
              );
            }

            const issueToken = params.issueHttpMcpSessionToken;
            const clearToken = params.clearHttpMcpSessionToken;
            const registerNotifier = params.registerHttpMcpActivityNotifier;
            const unregisterNotifier = params.unregisterHttpMcpActivityNotifier;
            const raw = streamWalkthroughViaAcp(
              {
                ...params,
                db,
                acpAgentId,
                deps: {
                  issueSessionToken: (walkthroughId) => issueToken(walkthroughId),
                  clearSessionToken: (token) => clearToken(token),
                  registerActivityNotifier: (walkthroughId, callback) =>
                    registerNotifier(walkthroughId, callback),
                  unregisterActivityNotifier: (walkthroughId) => unregisterNotifier(walkthroughId),
                },
              },
              // Guard the shared model against this agent (the chat bottom bar
              // may have left a chat-only agent's model id, e.g. cursor).
              resolveGenerationModel(agent, settings.aiModel),
              settings,
            );
            return guardWalkthroughStream(raw, {
              label: "walkthrough-acp",
              synthesizePhases: false,
            });
          }),
        ),

      chat: (params: ChatParams) =>
        Effect.withSpan("Ai.chat")(
          Effect.gen(function* () {
            const settings = yield* getSettings();
            // Chat runs exclusively on the ACP transport — the selected registry
            // agent drives it.
            const acpAgentId = applyAcpAgentOverride(settings.aiAgent);
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
              model: settings.aiModel ?? undefined,
              thinkingEffort: settings.aiThinkingEffort ?? undefined,
              contextWindow: settings.aiContextWindow ?? undefined,
              acpAgentId,
              deps: {
                issueChatMcpToken: (args: {
                  prId: string;
                  userId: string;
                  actor: "chat:acp";
                  interactionMode: InteractionMode;
                }) => Effect.runPromise(chatMcpTokens.issue(args)),
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
          const settings = yield* getSettings();
          const acpAgentId = applyAcpAgentOverride(settings.aiAgent);

          if (!isAcpAgentAvailable(acpAgentId)) {
            return yield* Effect.fail(new AiNotConfiguredError());
          }

          const systemPrompt = buildResolveConflictsPrompt({
            agentBranch: params.agentBranch,
            sourceBranch: params.sourceBranch,
            conflictFiles: params.conflictFiles,
          });
          const message = buildResolveConflictsUserMessage();

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
            model: settings.aiModel ?? undefined,
            thinkingEffort: settings.aiThinkingEffort ?? undefined,
            contextWindow: settings.aiContextWindow ?? undefined,
            acpAgentId,
            deps: {
              issueChatMcpToken: (args: {
                prId: string;
                userId: string;
                actor: "chat:acp";
                interactionMode: InteractionMode;
              }) => Effect.runPromise(chatMcpTokens.issue(args)),
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
