// The right-pane chat (and the merge-conflict agent) over the turn runner:
// maps the agent's session updates onto chat frames and builds the prompt.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { type ChatAttachment, extractMentionTokens, type InteractionMode } from "@revv/shared";
import { AiGenerationError } from "../../domain/errors";
import { logError } from "../../logger";
import { AgentTurnError } from "../acp/agent-failure";
import type { AgentLaunch } from "../acp/agent-launch";
import { CHAT_TURN, runAcpTurn, type TurnMcpServer } from "../acp/run-turn";
import { decodeAcpSessionUpdate, makeAcpDecodeState } from "../agent-stream/acp-decoders";
import { fluidEmit } from "../agent-stream/fluid-chunker";
import type { NormalizedAgentEvent } from "../agent-stream/normalized-events";
import { buildActivity, relativizeToolInput } from "../agent-stream/tool-activity";
import type { RawChatStreamFrame } from "./chat-types";

export interface StreamChatViaAcpOptions {
  readonly launch: AgentLaunch;
  readonly cwd: string;
  /** The raw user message: `@`-mentions are read from it. */
  readonly message: string;
  /**
   * The prompt text. A fresh session has neither the system prompt nor the
   * conversation, so it gets them; a reloaded one already has both.
   */
  readonly promptText: (freshSession: boolean) => string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly resumeSessionId?: string | null | undefined;
  /** Reports a fresh agent session id, awaited before the prompt is sent. */
  readonly onSessionId?: ((id: string) => Promise<void> | void) | undefined;
  readonly mcp?: TurnMcpServer | undefined;
  readonly interactionMode?: InteractionMode | undefined;
  readonly abortController?: AbortController | undefined;
  /** Runs once the turn is over, however it ended. */
  readonly onFinished?: (() => void) | undefined;
}

function attachmentUri(name: string): string {
  return `attachment://${encodeURIComponent(name)}`;
}

// `@path` mentions become ACP `resource_link` blocks. The shared grammar keeps
// the server and the web composer agreeing on what a mention is; the server
// adds the worktree confinement, and links only real files so `@TODO`-style
// prose never becomes a `file://` link the agent fails to read.
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

function toAiError(err: unknown): AiGenerationError {
  return err instanceof AgentTurnError
    ? new AiGenerationError({ cause: err, message: err.message, kind: err.kind })
    : new AiGenerationError({
        cause: err,
        message: err instanceof Error ? err.message : String(err),
      });
}

export function streamChatViaAcp(
  opts: StreamChatViaAcpOptions,
): ReadableStream<RawChatStreamFrame> {
  return new ReadableStream<RawChatStreamFrame>({
    async start(controller) {
      const planMode = opts.interactionMode === "plan";
      let hasEmittedText = false;
      let lastWasNonText = false;
      const planTextBuffer: string[] = [];
      const emit = (ev: NormalizedAgentEvent): void => {
        if (ev.kind === "text-delta") {
          if (planMode) planTextBuffer.push(ev.data);
          const needsSeparator = hasEmittedText && lastWasNonText && !ev.data.startsWith("\n");
          controller.enqueue({ kind: "text", data: needsSeparator ? `\n\n${ev.data}` : ev.data });
          hasEmittedText = true;
          lastWasNonText = false;
          return;
        }
        if (ev.kind === "reasoning-delta") {
          controller.enqueue({ kind: "reasoning", data: ev.data });
        } else if (ev.kind === "tool-call") {
          controller.enqueue({
            kind: "activity",
            ...buildActivity(ev.toolName, ev.input, opts.cwd, ev.callId),
          });
        } else if (ev.kind === "tool-result") {
          controller.enqueue({
            kind: "activity-result",
            callId: ev.callId,
            output: ev.output,
            isError: ev.isError,
          });
        } else if (ev.kind === "tool-call-update") {
          controller.enqueue({
            kind: "activity-input",
            callId: ev.callId,
            payload: relativizeToolInput(ev.input, opts.cwd),
          });
        } else if (ev.kind === "task-list-update") {
          controller.enqueue({ kind: "task-list", tasks: ev.tasks });
        } else {
          return;
        }
        lastWasNonText = true;
      };
      const fluid = fluidEmit(emit);
      const decodeState = makeAcpDecodeState();

      try {
        const { end } = await runAcpTurn({
          label: "chat-acp",
          launch: opts.launch,
          cwd: opts.cwd,
          ...(opts.mcp ? { mcp: opts.mcp } : {}),
          resumeSessionId: opts.resumeSessionId ?? null,
          mode: planMode ? "plan" : "default",
          deadlines: CHAT_TURN,
          ...(opts.abortController ? { signal: opts.abortController.signal } : {}),
          onSessionOpened: async (session) => {
            if (session.fresh && opts.onSessionId) await opts.onSessionId(session.sessionId);
            // Otherwise the reply silently comes from a model other than the picker's.
            if (session.unavailableModel) {
              controller.enqueue({
                kind: "text",
                data: `_Model "${session.unavailableModel}" isn't available, so this reply uses the agent's default model. Pick another model to change it._\n\n`,
              });
            }
          },
          prompt: (session) =>
            buildPromptBlocks({
              promptText: opts.promptText(session.fresh),
              message: opts.message,
              cwd: opts.cwd,
              attachments: opts.attachments ?? [],
              promptImage: session.promptImage,
              embeddedContext: session.embeddedContext,
            }),
          onUpdate: (update) => {
            for (const ev of decodeAcpSessionUpdate(update, decodeState)) fluid(ev);
          },
        });

        if (end.kind !== "stopped") throw new Error(end.reason);
        if (end.stopReason === "refusal") {
          controller.enqueue({ kind: "text", data: "\n\n_The agent declined to continue._" });
        }
        // In plan mode the buffered assistant turn is the plan.
        const planMarkdown = planMode ? planTextBuffer.join("").trim() : "";
        if (planMarkdown.length > 0) {
          controller.enqueue({ kind: "plan-presented", markdown: planMarkdown });
        }
        controller.close();
      } catch (err) {
        const error = toAiError(err);
        logError("chat-acp", "turn failed:", error.message ?? String(err));
        controller.error(error);
      } finally {
        opts.onFinished?.();
      }
    },
  });
}
