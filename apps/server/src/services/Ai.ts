import type { InteractionMode, WalkthroughStreamEvent } from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import {
  buildChatSystemPrompt,
  buildChatUserMessage,
  buildResolveConflictsPrompt,
  buildResolveConflictsUserMessage,
  type ChatHistoryEntry,
  type ChatPrContext,
  type ChatWalkthroughContext,
} from "../ai/prompts/chat";
import { type RawChatStreamFrame, streamChatViaClaude } from "../ai/providers/chat-claude";
import { streamChatViaCodex } from "../ai/providers/chat-codex";
import { streamChatViaOpencode } from "../ai/providers/chat-opencode";
// ── Prompt & provider imports (split out of this file) ──────────────────────
import { checkCliAvailability } from "../ai/providers/cli-agent";
import { type ContinuationContext, streamWalkthroughViaMCP } from "../ai/providers/mcp-walkthrough";
import type { CodexProviderDeps } from "../ai/providers/mcp-walkthrough-codex";
import { streamWalkthroughViaCodexMCP } from "../ai/providers/mcp-walkthrough-codex";
import { streamWalkthroughViaOpencodeMCP } from "../ai/providers/mcp-walkthrough-opencode";
import { makeOpencodeChatDeps, makeOpencodeWalkthroughDeps } from "../ai/providers/opencode-deps";
import { guardWalkthroughStream } from "../ai/providers/stream-guard";
import {
  type AiError,
  AiGenerationError,
  AiNotConfiguredError,
  type ValidationError,
} from "../domain/errors";
import { withDb } from "../effects/with-db";
import { logError } from "../logger";
import { ChatMcpTokens } from "./ChatMcpTokens";
import { ChatSessionService } from "./ChatSession";
import { DbService } from "./Db";
import type { PrFileMeta } from "./GitHub";
import { OpencodeSupervisor } from "./OpencodeSupervisor";
import { type AgentId, SettingsService } from "./Settings";

// ── Types ────────────────────────────────────────────────────────────────────

export type { ContinuationContext };

export interface ChatParams {
  readonly pr: ChatPrContext;
  readonly walkthrough: ChatWalkthroughContext | null;
  readonly message: string;
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

// ── Agent resolution ────────────────────────────────────────────────────────

export type CliAgent = AgentId;

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
       * opencode HTTP-MCP session token. Only consulted when the
       * resolved agent is 'opencode'; the Claude SDK path ignores them.
       * WalkthroughJobs supplies these because it owns the session-token
       * map (in-process, ephemeral per invariant #1). Kept as plain
       * callbacks so AiService doesn't need a layer dependency on
       * WalkthroughJobs (that would cycle — WalkthroughJobs depends on
       * AiService already).
       */
      issueOpencodeSessionToken?: (walkthroughId: string) => Promise<string>;
      clearOpencodeSessionToken?: (token: string) => Promise<void>;
      registerOpencodeActivityNotifier?: (
        walkthroughId: string,
        callback: (event: WalkthroughStreamEvent) => void,
      ) => Promise<void>;
      unregisterOpencodeActivityNotifier?: (walkthroughId: string) => Promise<void>;
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
    const supervisor = yield* OpencodeSupervisor;
    const chatMcpTokens = yield* ChatMcpTokens;
    const chatSessions = yield* ChatSessionService;

    // Invariant #14 (agent-daemon lifecycle): daemon-bound state is
    // ephemeral. When the opencode daemon exits — crash, idle cooldown,
    // settings change — every session id we recorded for it now points
    // to a process that's gone. Drop those rows so the next chat turn
    // for any PR creates a fresh session with the system prompt + walk-
    // through context re-attached, instead of trying to resume against
    // the new daemon (which would 404, manifesting as Bug 1).
    //
    // Best-effort: failures here only mean the next chat turn might
    // still hit a stale id and surface an error to the user. The exit
    // handler is fire-and-forget by contract — never throw.
    supervisor.onDaemonExit(() => {
      void Effect.runPromise(chatSessions.clearAllForAgent("opencode")).catch((err) => {
        logError(
          "ai",
          "clearAllForAgent(opencode) failed on daemon exit:",
          err instanceof Error ? err.message : String(err),
        );
      });
    });

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

    // Check if a CLI agent is available
    const checkConfigured = (): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const agent = yield* getAgent();
        return checkCliAvailability(agent);
      }).pipe(Effect.catchAll(() => Effect.succeed(false)));

    return {
      streamWalkthrough: (params) =>
        Effect.withSpan("Ai.streamWalkthrough", {
          attributes: { walkthroughId: params.walkthroughId },
        })(
          Effect.gen(function* () {
            const settings = yield* getSettings();
            const agent = yield* getAgent();

            if (!checkCliAvailability(agent)) {
              return yield* Effect.fail(new AiNotConfiguredError());
            }

            // Both providers receive the same param shape (including
            // walkthroughId + db) and the tool handlers they register
            // are byte-for-byte the same code — doctrine invariant #13
            // (Agent-path parity).
            const providerParams = { ...params, db };

            if (agent === "opencode") {
              if (!params.issueOpencodeSessionToken || !params.clearOpencodeSessionToken) {
                return yield* Effect.fail(
                  new AiGenerationError({
                    cause: new Error("missing opencode session-token callbacks"),
                    message: "opencode provider requires caller-supplied session-token callbacks",
                  }),
                );
              }
              if (
                !params.registerOpencodeActivityNotifier ||
                !params.unregisterOpencodeActivityNotifier
              ) {
                return yield* Effect.fail(
                  new AiGenerationError({
                    cause: new Error("missing opencode activity-notifier callbacks"),
                    message:
                      "opencode provider requires caller-supplied activity-notifier callbacks",
                  }),
                );
              }
              const deps = makeOpencodeWalkthroughDeps(supervisor, {
                issueSessionToken: params.issueOpencodeSessionToken,
                clearSessionToken: params.clearOpencodeSessionToken,
                registerActivityNotifier: params.registerOpencodeActivityNotifier,
                unregisterActivityNotifier: params.unregisterOpencodeActivityNotifier,
              });
              const raw = streamWalkthroughViaOpencodeMCP(
                { ...providerParams, deps },
                settings.aiModel ?? undefined,
                settings,
              );
              return guardWalkthroughStream(raw, {
                label: "opencode-mcp",
                synthesizePhases: false,
              });
            }

            if (agent === "codex") {
              // Codex reuses the same HTTP-MCP session-token + activity-notifier
              // callbacks opencode uses (the `*Opencode*` names are historical —
              // they serve both HTTP-MCP agents). It needs no daemon deps.
              if (!params.issueOpencodeSessionToken || !params.clearOpencodeSessionToken) {
                return yield* Effect.fail(
                  new AiGenerationError({
                    cause: new Error("missing HTTP-MCP session-token callbacks"),
                    message: "codex provider requires caller-supplied session-token callbacks",
                  }),
                );
              }
              if (
                !params.registerOpencodeActivityNotifier ||
                !params.unregisterOpencodeActivityNotifier
              ) {
                return yield* Effect.fail(
                  new AiGenerationError({
                    cause: new Error("missing HTTP-MCP activity-notifier callbacks"),
                    message: "codex provider requires caller-supplied activity-notifier callbacks",
                  }),
                );
              }
              const issueToken = params.issueOpencodeSessionToken;
              const clearToken = params.clearOpencodeSessionToken;
              const registerNotifier = params.registerOpencodeActivityNotifier;
              const unregisterNotifier = params.unregisterOpencodeActivityNotifier;
              const codexDeps: CodexProviderDeps = {
                issueSessionToken: (walkthroughId) => issueToken(walkthroughId),
                clearSessionToken: (token) => clearToken(token),
                registerActivityNotifier: (walkthroughId, callback) =>
                  registerNotifier(walkthroughId, callback),
                unregisterActivityNotifier: (walkthroughId) => unregisterNotifier(walkthroughId),
              };
              const raw = streamWalkthroughViaCodexMCP(
                { ...providerParams, deps: codexDeps },
                settings.aiModel ?? undefined,
                settings,
              );
              return guardWalkthroughStream(raw, {
                label: "codex-mcp",
                synthesizePhases: false,
              });
            }

            const raw = streamWalkthroughViaMCP(
              providerParams,
              settings.aiModel ?? undefined,
              settings,
            );
            return guardWalkthroughStream(raw, { label: "claude-mcp", synthesizePhases: false });
          }),
        ),

      chat: (params: ChatParams) =>
        Effect.withSpan("Ai.chat")(
          Effect.gen(function* () {
            const settings = yield* getSettings();
            const agent = yield* getAgent();
            yield* Effect.annotateCurrentSpan("prId", params.prId);
            yield* Effect.annotateCurrentSpan("provider", agent);

            if (!checkCliAvailability(agent)) {
              return yield* Effect.fail(new AiNotConfiguredError());
            }

            const systemPrompt = buildChatSystemPrompt({
              pr: params.pr,
              walkthrough: params.walkthrough,
              branchName: params.branchName,
            });
            // Only inline the `## Conversation history` block on a fresh
            // session (no resume id). On resume, the agent daemon already
            // has the prior turns in its own session state; sending the
            // transcript again causes the agent to echo it back into its
            // response, which then renders as a visible "Conversation
            // history" block in the chat bubble.
            const message = params.resumeSessionId
              ? params.message
              : buildChatUserMessage({
                  message: params.message,
                  history: params.history,
                });

            if (agent === "claude") {
              return streamChatViaClaude({
                message,
                systemPrompt,
                resumeSessionId: params.resumeSessionId ?? undefined,
                cwd: params.cwd,
                onSessionId: params.onSessionId,
                abortController: params.abortController,
                model: settings.aiModel ?? undefined,
                db,
                prId: params.prId,
                userId: params.userId,
                maxTurns: settings.aiMaxTurns,
                interactionMode: params.interactionMode,
              });
            }

            if (agent === "codex") {
              return streamChatViaCodex({
                message,
                systemPrompt,
                resumeSessionId: params.resumeSessionId ?? undefined,
                cwd: params.cwd,
                onSessionId: params.onSessionId,
                abortController: params.abortController,
                model: settings.aiModel ?? undefined,
                deps: {
                  issueChatMcpToken: (args: {
                    prId: string;
                    userId: string;
                    actor: "chat:codex";
                    interactionMode: InteractionMode;
                  }) => Effect.runPromise(chatMcpTokens.issue(args)),
                  clearChatMcpToken: (token: string) =>
                    Effect.runPromise(chatMcpTokens.clear(token)),
                },
                prId: params.prId,
                userId: params.userId,
                interactionMode: params.interactionMode,
              });
            }

            // opencode path
            const deps = makeOpencodeChatDeps(supervisor, chatMcpTokens);
            return streamChatViaOpencode({
              message,
              systemPrompt,
              resumeSessionId: params.resumeSessionId ?? undefined,
              cwd: params.cwd,
              onSessionId: params.onSessionId,
              abortController: params.abortController,
              model: settings.aiModel ?? undefined,
              deps,
              prId: params.prId,
              userId: params.userId,
              interactionMode: params.interactionMode,
            });
          }),
        ),

      resolveMergeConflict: (params) =>
        Effect.gen(function* () {
          const settings = yield* getSettings();
          const agent = yield* getAgent();

          if (!checkCliAvailability(agent)) {
            return yield* Effect.fail(new AiNotConfiguredError());
          }

          const systemPrompt = buildResolveConflictsPrompt({
            agentBranch: params.agentBranch,
            sourceBranch: params.sourceBranch,
            conflictFiles: params.conflictFiles,
          });
          const message = buildResolveConflictsUserMessage();

          if (agent === "claude") {
            return streamChatViaClaude({
              message,
              systemPrompt,
              // No resume — this is a one-shot run that must
              // not pull in any prior conversation context.
              resumeSessionId: undefined,
              cwd: params.cwd,
              onSessionId: undefined,
              abortController: params.abortController,
              model: settings.aiModel ?? undefined,
              db,
              prId: params.prId,
              userId: params.userId,
              // Critical: no persistence — this turn must NOT
              // land in the chat session JSONL on disk, so a
              // future regular chat resume doesn't see the
              // system prompt that allowed `git merge --continue`.
              persistSession: false,
              // And no review-context MCP — conflict resolution
              // doesn't need it.
              enableReviewContextMcp: false,
              maxTurns: settings.aiMaxTurns,
            });
          }

          if (agent === "codex") {
            return streamChatViaCodex({
              message,
              systemPrompt,
              resumeSessionId: undefined,
              cwd: params.cwd,
              onSessionId: undefined,
              abortController: params.abortController,
              model: settings.aiModel ?? undefined,
              deps: {
                issueChatMcpToken: (args: {
                  prId: string;
                  userId: string;
                  actor: "chat:codex";
                  interactionMode: InteractionMode;
                }) => Effect.runPromise(chatMcpTokens.issue(args)),
                clearChatMcpToken: (token: string) => Effect.runPromise(chatMcpTokens.clear(token)),
              },
              prId: params.prId,
              userId: params.userId,
              // No review-context MCP — conflict resolution doesn't need it.
              enableReviewContextMcp: false,
            });
          }

          // opencode: run a fresh, non-resumed session. The opencode
          // daemon is stateful per session id; using `undefined`
          // here forces a brand-new session that disappears when
          // the daemon idles out.
          const deps = makeOpencodeChatDeps(supervisor, chatMcpTokens);
          return streamChatViaOpencode({
            message,
            systemPrompt,
            resumeSessionId: undefined,
            cwd: params.cwd,
            onSessionId: undefined,
            abortController: params.abortController,
            model: settings.aiModel ?? undefined,
            deps,
            prId: params.prId,
            userId: params.userId,
          });
        }),

      isConfigured: () => checkConfigured(),
    };
  }),
);
