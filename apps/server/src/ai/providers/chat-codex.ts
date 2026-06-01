// ── chat-codex ──────────────────────────────────────────────────────────────
//
// Codex driver for the right-pane chat. Drives the agent in-process via
// `@openai/codex-sdk` (like Claude — the SDK owns the `codex` subprocess) while
// routing the review-context + walkthrough-edit MCP tools through the shared
// `/mcp/chat-context` HTTP route (like opencode — registered on the codex CLI
// via `config.mcp_servers` with a bearer token). The provider-level surface
// (param shape, normalized event union, emit→ChatStreamFrame mapping) matches
// the other two drivers (invariant #13).
//
// Codex threads persist under `~/.codex/sessions`; we remember the thread id in
// `chat_sessions` and resume by id on the next turn — the same resume contract
// as the other providers.

import { Codex } from "@openai/codex-sdk";
import type { InteractionMode } from "@revv/shared";
import { serverEnv } from "../../config";
import { CLI_CHAT_TURN_TIMEOUT_MS } from "../../constants";
import { AiGenerationError } from "../../domain/errors";
import { debug, logError } from "../../logger";
import {
  buildActivity,
  fluidEmit,
  type NormalizedAgentEvent,
  walkCodexEvents,
  withAgentTurn,
} from "../agent-stream";
import type { RawChatStreamFrame } from "./chat-types";
import { resolveCliBin } from "./cli-agent";

export interface CodexChatDeps {
  /**
   * Mint a bearer token bound to the current PR, user, actor, and interaction
   * mode for the chat MCP route. The route uses these to stamp
   * `walkthroughs.lastEditedBy` and to filter edit tools out of `tools/list`
   * in plan mode.
   */
  readonly issueChatMcpToken: (args: {
    prId: string;
    userId: string;
    actor: "chat:codex";
    interactionMode: InteractionMode;
  }) => Promise<string>;
  /** Revoke the token once the turn ends. */
  readonly clearChatMcpToken: (token: string) => Promise<void>;
}

export interface StreamChatViaCodexOptions {
  readonly message: string;
  readonly systemPrompt: string;
  readonly resumeSessionId?: string | undefined;
  readonly cwd: string;
  /**
   * Awaited as soon as codex emits `thread.started`, so the route's SQLite
   * upsert of `(prId, agent, headSha) → sessionId` commits before any
   * user-visible content streams.
   */
  readonly onSessionId?: ((id: string) => Promise<void> | void) | undefined;
  readonly abortController?: AbortController | undefined;
  readonly model?: string | undefined;
  readonly deps: CodexChatDeps;
  readonly prId: string;
  readonly userId: string;
  /**
   * When `false`, the chat-context MCP server is not registered. Used by the
   * merge-conflict path which wants a leaner tool surface (codex still has
   * its built-in Read/Edit/Bash). Defaults to `true`.
   */
  readonly enableReviewContextMcp?: boolean | undefined;
  /**
   * Session-level interaction toggle. In `'plan'` mode codex runs read-only
   * (no worktree mutation) and the full assistant turn is synthesized into a
   * single `plan-presented` frame — codex has no structured plan delimiter.
   */
  readonly interactionMode?: InteractionMode | undefined;
}

const CHAT_CONTEXT_MCP_SERVER = "revv-chat-context";

export function streamChatViaCodex(
  opts: StreamChatViaCodexOptions,
): ReadableStream<RawChatStreamFrame> {
  return new ReadableStream<RawChatStreamFrame>({
    async start(controller) {
      let chatMcpToken: string | null = null;
      let capturedThreadId: string | null = opts.resumeSessionId ?? null;

      try {
        const planMode = opts.interactionMode === "plan";
        const enableMcp = opts.enableReviewContextMcp ?? true;

        // Mint the token BEFORE constructing Codex — the bearer header is
        // baked into the config at construction. Revoked in `finally`.
        // Typed concretely (not `unknown`) so it satisfies the SDK's
        // `CodexConfigObject` shape under exactOptionalPropertyTypes.
        const mcpServers: Record<
          string,
          { url: string; http_headers: Record<string, string>; startup_timeout_sec: number }
        > = {};
        if (enableMcp) {
          chatMcpToken = await opts.deps.issueChatMcpToken({
            prId: opts.prId,
            userId: opts.userId,
            actor: "chat:codex",
            interactionMode: opts.interactionMode ?? "default",
          });
          const mcpUrl = `http://127.0.0.1:${serverEnv.port}/mcp/chat-context`;
          mcpServers[`${CHAT_CONTEXT_MCP_SERVER}-${opts.prId}`] = {
            url: mcpUrl,
            http_headers: { Authorization: `Bearer ${chatMcpToken}` },
            startup_timeout_sec: 30,
          };
        }

        const pinned = resolveCliBin("codex");
        const codex = new Codex({
          ...(pinned !== "codex" ? { codexPathOverride: pinned } : {}),
          ...(Object.keys(mcpServers).length > 0 ? { config: { mcp_servers: mcpServers } } : {}),
        });
        // `codex exec` is one-way (no approver), so MCP tool calls
        // (get_review_context + the walkthrough-edit tools) only execute under
        // danger-full-access + approval=never — read-only / workspace-write
        // auto-cancel them. Parity with the Claude chat path's
        // bypassPermissions. Plan-mode's read-only intent is enforced by the
        // MCP tool surface (edit tools filtered out of tools/list by
        // interactionMode), not by the codex sandbox.
        const threadOptions = {
          workingDirectory: opts.cwd,
          skipGitRepoCheck: true,
          sandboxMode: "danger-full-access" as const,
          approvalPolicy: "never" as const,
          ...(opts.model ? { model: opts.model } : {}),
        };
        const thread = opts.resumeSessionId
          ? codex.resumeThread(opts.resumeSessionId, threadOptions)
          : codex.startThread(threadOptions);

        // Codex has no separate system-prompt channel — prepend it to the
        // first turn's input. On resume the thread already carries it.
        const input = opts.resumeSessionId
          ? opts.message
          : `${opts.systemPrompt}\n\n---\n\n${opts.message}`;

        // ── normalized event → RawChatStreamFrame mapping ─────────
        let hasEmittedText = false;
        let lastWasNonText = false;
        const planTextBuffer: string[] = [];
        const emit = (ev: NormalizedAgentEvent): void => {
          if (ev.kind === "text-delta") {
            if (planMode) planTextBuffer.push(ev.data);
            const needsSeparator = hasEmittedText && lastWasNonText && !ev.data.startsWith("\n");
            const data = needsSeparator ? `\n\n${ev.data}` : ev.data;
            controller.enqueue({ kind: "text", data });
            hasEmittedText = true;
            lastWasNonText = false;
          } else if (ev.kind === "reasoning-delta") {
            controller.enqueue({ kind: "reasoning", data: ev.data });
            lastWasNonText = true;
          } else if (ev.kind === "tool-call") {
            const activity = buildActivity(ev.toolName, ev.input);
            controller.enqueue({ kind: "activity", ...activity });
            lastWasNonText = true;
          } else if (ev.kind === "task-list-update") {
            controller.enqueue({ kind: "task-list", source: ev.source, tasks: ev.tasks });
            lastWasNonText = true;
          } else if (ev.kind === "error") {
            logError("chat-codex", "session.error:", ev.message);
            controller.enqueue({ kind: "text", data: `\n\n_Error: ${ev.message}_` });
            hasEmittedText = true;
            lastWasNonText = false;
          }
          // Codex emits no subagent / plan / user-question items — those
          // NormalizedAgentEvent kinds never arrive here.
        };
        const wrappedEmit = fluidEmit(emit);

        await withAgentTurn({
          externalAbort: opts.abortController,
          hardTimeoutMs: CLI_CHAT_TURN_TIMEOUT_MS,
          jobStarted: async () => {},
          jobEnded: async () => {},
          debugLabel: "chat-codex",
          run: async (ctx) => {
            const { events } = await thread.runStreamed(input, { signal: ctx.signal });
            await walkCodexEvents(events, wrappedEmit, {
              onThreadStarted: async (threadId) => {
                capturedThreadId = threadId;
                if (opts.onSessionId) await opts.onSessionId(threadId);
              },
            });
          },
        });

        // Plan-mode synthesis: the entire buffered assistant turn IS the plan.
        if (planMode) {
          const planMarkdown = planTextBuffer.join("").trim();
          if (planMarkdown.length > 0) {
            controller.enqueue({
              kind: "plan-presented",
              providerPlanId: `codex-plan-${capturedThreadId ?? opts.prId}`,
              markdown: planMarkdown,
              source: "codex",
            });
          }
        }

        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError("chat-codex", "queryTask error:", msg);
        controller.error(new AiGenerationError({ cause: err, message: msg }));
      } finally {
        if (chatMcpToken) {
          try {
            await opts.deps.clearChatMcpToken(chatMcpToken);
          } catch {
            /* ignore */
          }
        }
        debug("chat-codex", "turn ended");
      }
    },
  });
}
