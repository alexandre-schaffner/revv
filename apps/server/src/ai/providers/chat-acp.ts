// ── chat-acp ───────────────────────────────────────────────────────────────
//
// ACP (Agent Client Protocol) driver for the right-pane chat. This is the
// unified transport meant to replace the bespoke claude/opencode/codex chat
// drivers: it talks to whichever ACP agent is configured (see ai/acp/presets.ts)
// over a stdio JSON-RPC connection pooled per worktree (ai/acp/acp-connection.ts).
//
// Like the other drivers it returns a `ReadableStream<RawChatStreamFrame>` and
// maps the normalized agent events onto chat frames — so nothing downstream
// (persistence, SSE encoder, the web chat panel) changes.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContentBlock, McpServer, SessionModeState } from "@agentclientprotocol/sdk";
import {
  type AcpAgentId,
  type ChatAttachment,
  type ContextWindow,
  extractMentionTokens,
  type InteractionMode,
  type ThinkingEffort,
} from "@revv/shared";
import { serverEnv } from "../../config";
import { CLI_CHAT_TURN_TIMEOUT_MS } from "../../constants";
import { AiGenerationError } from "../../domain/errors";
import { debug, logError } from "../../logger";
import { getAcpConnection } from "../acp/acp-connection";
import {
  buildActivity,
  decodeAcpSessionUpdate,
  fluidEmit,
  makeAcpDecodeState,
  type NormalizedAgentEvent,
  withAgentTurn,
} from "../agent-stream";
import { AgentUnavailableError } from "./chat-agent-errors";
import type { RawChatStreamFrame } from "./chat-types";

export { AgentUnavailableError } from "./chat-agent-errors";

export interface AcpChatDeps {
  /**
   * Mint a bearer token bound to the current PR/user/actor/interaction mode for
   * the chat-context HTTP MCP route — the same registry the opencode/codex
   * drivers use. The route stamps `walkthroughs.lastEditedBy` and filters edit
   * tools out of `tools/list` in plan mode.
   */
  readonly issueChatMcpToken: (args: {
    prId: string;
    userId: string;
    actor: "chat:acp";
    interactionMode: InteractionMode;
  }) => Promise<string>;
  /** Revoke the token once the turn ends. */
  readonly clearChatMcpToken: (token: string) => Promise<void>;
}

export interface StreamChatViaAcpOptions {
  readonly message: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly systemPrompt: string;
  readonly resumeSessionId?: string | undefined;
  readonly cwd: string;
  readonly onSessionId?: ((id: string) => Promise<void> | void) | undefined;
  readonly abortController?: AbortController | undefined;
  /** Selected Revv model. Propagated into the adapter at launch where supported (presets.ts). */
  readonly model?: string | undefined;
  /** Selected thinking-effort tier. Propagated to Claude Code / Codex at launch. */
  readonly thinkingEffort?: ThinkingEffort | undefined;
  /** Selected context window. Propagated to Claude Code at launch (200K vs 1M). */
  readonly contextWindow?: ContextWindow | undefined;
  readonly acpAgentId: AcpAgentId;
  readonly deps: AcpChatDeps;
  readonly prId: string;
  readonly userId: string;
  readonly interactionMode?: InteractionMode | undefined;
  /** When `false`, the chat-context MCP server is not handed to the agent. */
  readonly enableReviewContextMcp?: boolean | undefined;
}

const CHAT_CONTEXT_MCP_SERVER = "revv-chat-context";

/** Pick a read-only/plan/architect mode from the agent's advertised modes. */
function findPlanModeId(modes: SessionModeState | null): string | undefined {
  if (!modes) return undefined;
  for (const mode of modes.availableModes) {
    const haystack = `${mode.id} ${mode.name} ${mode.description ?? ""}`.toLowerCase();
    if (/(plan|ask|architect|read.?only|readonly)/.test(haystack)) return mode.id;
  }
  return undefined;
}

function attachmentUri(name: string): string {
  return `attachment://${encodeURIComponent(name)}`;
}

// Resolve `@path/to/file` mentions in the user's message into ACP
// `resource_link` blocks. Tokenization uses the shared grammar
// (`extractMentionTokens`) so the server and the web composer agree on what a
// mention is; here we add the server-only concerns: reject path traversal /
// absolute paths, and emit a link only for paths that resolve to a real file
// inside the worktree — so dangling `@TODO`-style prose tokens never become
// `file://` links the agent might try (and fail) to read.
function extractFileReferences(message: string, cwd: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const path of extractMentionTokens(message)) {
    if (path.startsWith("/") || path.includes("..")) continue;
    const absolute = join(cwd, path);
    if (!existsSync(absolute)) continue;
    blocks.push({
      type: "resource_link",
      uri: pathToFileURL(absolute).toString(),
      name: path,
    });
  }
  return blocks;
}

function buildPromptBlocks(opts: {
  readonly promptText: string;
  /** The raw user message — `@`-mentions are scanned from this, not promptText. */
  readonly message: string;
  readonly cwd: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly promptImage: boolean;
  readonly embeddedContext: boolean;
}): ContentBlock[] {
  const notes: string[] = [];
  let text = opts.promptText;
  const blocks: ContentBlock[] = [];

  for (const attachment of opts.attachments) {
    if (attachment.kind === "image") {
      if (opts.promptImage) {
        blocks.push({
          type: "image",
          data: attachment.data,
          mimeType: attachment.mimeType,
        });
      } else {
        notes.push(
          `Image attachment "${attachment.name}" was omitted because this agent does not support image prompts.`,
        );
      }
    } else if (opts.embeddedContext) {
      blocks.push({
        type: "resource",
        resource: {
          uri: attachmentUri(attachment.name),
          text: attachment.data,
          mimeType: attachment.mimeType,
        },
      });
    } else {
      text += `\n\n---\n\nAttached file: ${attachment.name}\n\n${attachment.data}`;
    }
  }

  if (notes.length > 0) {
    text += `\n\n${notes.join("\n")}`;
  }

  return [{ type: "text", text }, ...extractFileReferences(opts.message, opts.cwd), ...blocks];
}

export function streamChatViaAcp(
  opts: StreamChatViaAcpOptions,
): ReadableStream<RawChatStreamFrame> {
  return new ReadableStream<RawChatStreamFrame>({
    async start(controller) {
      let chatMcpToken: string | null = null;
      let sessionId: string | null = opts.resumeSessionId ?? null;
      let handle: Awaited<ReturnType<typeof getAcpConnection>> | null = null;
      const planMode = opts.interactionMode === "plan";

      try {
        const h = await getAcpConnection(opts.cwd, opts.acpAgentId, {
          model: opts.model,
          thinkingEffort: opts.thinkingEffort,
          contextWindow: opts.contextWindow,
        });
        handle = h;

        // Hand the agent our chat-context HTTP MCP endpoint (review context +
        // walkthrough-edit tools), unless disabled (merge-conflict path). Token
        // is revoked in `finally`. Degrade loudly but non-fatally if the agent
        // doesn't support HTTP MCP — it still has its own Read/Edit/Bash tools.
        const enableMcp = opts.enableReviewContextMcp ?? true;
        const mcpServers: McpServer[] = [];
        if (enableMcp) {
          if (!h.httpMcpSupported) {
            debug("chat-acp", "agent does not advertise HTTP MCP — skipping chat-context tools");
          } else {
            chatMcpToken = await opts.deps.issueChatMcpToken({
              prId: opts.prId,
              userId: opts.userId,
              actor: "chat:acp",
              interactionMode: opts.interactionMode ?? "default",
            });
            mcpServers.push({
              type: "http",
              name: `${CHAT_CONTEXT_MCP_SERVER}-${opts.prId}`,
              url: `http://127.0.0.1:${serverEnv.port}/mcp/chat-context`,
              headers: [{ name: "Authorization", value: `Bearer ${chatMcpToken}` }],
            });
          }
        }

        // Resolve the session: resume via session/load when supported, else a
        // fresh session/new whose id we report so the route can persist it.
        let modes: SessionModeState | null = null;
        if (sessionId && h.loadSessionSupported) {
          modes = await h.loadSession(sessionId, mcpServers);
        } else {
          const created = await h.newSession(mcpServers);
          sessionId = created.sessionId;
          modes = created.modes;
          if (opts.onSessionId) await opts.onSessionId(sessionId);
        }
        const turnSessionId = sessionId;

        // Plan mode: switch the agent into its read-only mode. Mirrors the
        // opencode driver's behaviour — if the agent has no such mode, surface a
        // structured AgentUnavailableError the route renders as a 422.
        if (planMode) {
          const planModeId = findPlanModeId(modes);
          if (!planModeId) throw new AgentUnavailableError("plan");
          await h.setMode(turnSessionId, planModeId);
          h.setPlanMode(turnSessionId, true);
        }

        // Map normalized events → ChatStreamFrame. Same shape as the opencode
        // driver: paragraph-break insertion between text and non-text events,
        // plan-mode text buffering for a synthesized `plan-presented`.
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
            controller.enqueue({ kind: "task-list", tasks: ev.tasks });
            lastWasNonText = true;
          } else if (ev.kind === "error") {
            logError("chat-acp", "session.error:", ev.message);
            controller.enqueue({ kind: "text", data: `\n\n_Error: ${ev.message}_` });
            hasEmittedText = true;
            lastWasNonText = false;
          }
        };
        const wrappedEmit = fluidEmit(emit);
        const decodeState = makeAcpDecodeState();
        h.setListener(turnSessionId, (update) => {
          for (const ev of decodeAcpSessionUpdate(update, decodeState)) wrappedEmit(ev);
        });

        // ACP has no separate system-prompt channel; prepend it on a fresh
        // session (codex-style). On resume the agent already has it in context.
        const promptText = opts.resumeSessionId
          ? opts.message
          : `${opts.systemPrompt}\n\n---\n\n${opts.message}`;
        const promptBlocks = buildPromptBlocks({
          promptText,
          message: opts.message,
          cwd: opts.cwd,
          attachments: opts.attachments ?? [],
          promptImage: h.promptImage,
          embeddedContext: h.embeddedContext,
        });

        await withAgentTurn({
          externalAbort: opts.abortController,
          hardTimeoutMs: CLI_CHAT_TURN_TIMEOUT_MS,
          jobStarted: async () => {
            h.jobStarted();
          },
          jobEnded: async () => {
            h.jobEnded();
          },
          debugLabel: "chat-acp",
          abortSession: async () => {
            await h.cancel(turnSessionId);
          },
          run: async () => {
            const stopReason = await h.prompt(turnSessionId, promptBlocks);
            if (stopReason === "refusal") {
              controller.enqueue({ kind: "text", data: "\n\n_The agent declined to continue._" });
            }
          },
        });

        // Plan-mode synthesis: the buffered assistant turn IS the plan.
        if (planMode) {
          const planMarkdown = planTextBuffer.join("").trim();
          if (planMarkdown.length > 0) {
            controller.enqueue({
              kind: "plan-presented",
              providerPlanId: `acp-plan-${turnSessionId}`,
              markdown: planMarkdown,
            });
          }
        }

        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError("chat-acp", "queryTask error:", msg);
        controller.error(new AiGenerationError({ cause: err, message: msg }));
      } finally {
        if (handle && sessionId) {
          handle.setListener(sessionId, null);
          handle.setPlanMode(sessionId, false);
        }
        if (chatMcpToken) {
          try {
            await opts.deps.clearChatMcpToken(chatMcpToken);
          } catch {
            /* ignore */
          }
        }
      }
    },
  });
}
