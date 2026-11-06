// The only place ACP `session/update` wire shapes are interpreted; providers
// consume the normalized events.

import type {
  PlanEntry,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { encodeToolDiffOutput } from "@revv/shared";
import {
  type NormalizedAgentEvent,
  type NormalizedTask,
  normalizeTaskPriority,
  normalizeTaskStatus,
} from "./normalized-events";

/**
 * ACP carries no machine tool name (only a human `title` + a `kind` enum), but
 * the `rawInput` of adapters that wrap a known SDK (e.g. claude-agent-acp)
 * uses that SDK's parameter names, so a canonical name yields correct activity
 * icons and summaries.
 */
function acpKindToToolName(kind: ToolKind | undefined, title: string): string {
  switch (kind) {
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "search":
      return "Grep";
    case "execute":
    case "delete":
    case "move":
      return "Bash";
    case "fetch":
      return "WebFetch";
    default:
      return title || "Tool";
  }
}

export interface AcpDecodeState {
  /** Tool-call ids already surfaced, so re-sent updates don't double-emit. */
  readonly seenToolCallIds: Set<string>;
  /** Some agents re-send the terminal `tool_call_update`. */
  readonly resultEmittedToolCallIds: Set<string>;
  readonly inputUpdatedToolCallIds: Set<string>;
  /**
   * Merged across the `tool_call` and every `tool_call_update`: edit
   * before/after strings often arrive on a different update than the terminal
   * one.
   */
  readonly inputByToolCallId: Map<string, Record<string, unknown>>;
  /** Text already emitted per message, keyed `msg:<id>` / `thought:<id>`. */
  readonly emittedTextByKey: Map<string, string>;
}

export function makeAcpDecodeState(): AcpDecodeState {
  return {
    seenToolCallIds: new Set(),
    resultEmittedToolCallIds: new Set(),
    inputUpdatedToolCallIds: new Set(),
    inputByToolCallId: new Map(),
    emittedTextByKey: new Map(),
  };
}

/**
 * Unwrap a single outer markdown code fence (```lang … ```), which some agents
 * (claude-agent-acp) wrap shell/tool output in — otherwise the literal fence
 * shows in the terminal peek. Only unwraps when the whole text is one fence.
 */
function stripCodeFence(text: string): string {
  const m = text.match(/^```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  return m?.[1] !== undefined ? m[1] : text;
}

/** Keeps a giant file read or log dump out of the SSE frame and the persisted journal. */
const MAX_TOOL_OUTPUT_CHARS = 16_000;

function truncateOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (truncated)`;
}

/**
 * No truncation marker, unlike {@link truncateOutput}: it would render as a
 * spurious added/removed line in the diff peek.
 */
function truncateDiffSide(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const slice = text.slice(0, MAX_TOOL_OUTPUT_CHARS);
  const lastNl = slice.lastIndexOf("\n");
  return lastNl > 0 ? slice.slice(0, lastNl) : slice;
}

function diffJson(path: string, oldText: string, newText: string): string {
  return encodeToolDiffOutput(path, truncateDiffSide(oldText), truncateDiffSide(newText));
}

/**
 * For agents that don't emit a `diff` content block. Claude's Edit uses
 * `old_string`/`new_string`; opencode uses `oldString`/`newString`.
 */
function editDiffFromInput(rawInput: unknown): { old: string; new: string; path: string } | null {
  if (!rawInput || typeof rawInput !== "object") return null;
  const o = rawInput as Record<string, unknown>;
  const str = (k: string): string | null => (typeof o[k] === "string" ? (o[k] as string) : null);
  const oldText = str("old_string") ?? str("oldString");
  const newText = str("new_string") ?? str("newString");
  if (oldText === null || newText === null) return null;
  return { old: oldText, new: newText, path: str("file_path") ?? str("path") ?? "" };
}

/**
 * An edit becomes a structured old/new pair so the UI can render a true diff
 * and LOC counts; everything else is best-effort display text.
 */
function extractToolOutput(
  content: ToolCallContent[] | null | undefined,
  rawInput: unknown,
  rawOutput: unknown,
): string {
  for (const item of content ?? []) {
    if (item.type === "diff") return diffJson(item.path, item.oldText ?? "", item.newText ?? "");
  }
  const edit = editDiffFromInput(rawInput);
  if (edit) return diffJson(edit.path, edit.old, edit.new);

  const parts: string[] = [];
  for (const item of content ?? []) {
    if (item.type === "content" && item.content.type === "text") parts.push(item.content.text);
  }
  let text = parts.join("\n").trim();
  if (!text && rawOutput != null) {
    text = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput, null, 2);
  }
  return truncateOutput(stripCodeFence(text));
}

/**
 * Some adapters (claude-agent-acp) send the initial `tool_call` with an
 * empty/partial `rawInput`; the touched file only shows up in `locations`.
 * Folding it in lets Read/Edit/Write cards render their filename instead of a
 * bare "Read".
 */
function enrichToolInput(
  rawInput: unknown,
  locations: ToolCallLocation[] | null | undefined,
): unknown {
  const base: Record<string, unknown> =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? { ...(rawInput as Record<string, unknown>) }
      : {};
  const locPath = locations?.[0]?.path;
  if (typeof locPath === "string" && locPath.length > 0) {
    if (typeof base.file_path !== "string") base.file_path = locPath;
    if (typeof base.path !== "string") base.path = locPath;
  }
  return base;
}

function hasUsableInput(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const o = input as Record<string, unknown>;
  return ["file_path", "path", "command", "pattern"].some(
    (k) => typeof o[k] === "string" && (o[k] as string).length > 0,
  );
}

/**
 * Reconcile one streamed chunk against what's already been emitted for a message
 * and return only the NEW text. Handles both ACP streaming styles:
 *   - incremental deltas followed by a final cumulative restatement
 *     (claude-agent-acp: "ACP", "_OK", then "ACP_OK") — the restatement is dropped;
 *   - purely cumulative chunks ("ACP", then "ACP_OK") — only the suffix is kept.
 */
function nextTextDelta(state: AcpDecodeState, key: string, chunk: string): string {
  const prev = state.emittedTextByKey.get(key) ?? "";
  if (chunk === prev) return "";
  if (prev.length > 0 && chunk.startsWith(prev)) {
    state.emittedTextByKey.set(key, chunk);
    return chunk.slice(prev.length);
  }
  state.emittedTextByKey.set(key, prev + chunk);
  return chunk;
}

export function decodeAcpSessionUpdate(
  update: SessionUpdate,
  state: AcpDecodeState,
): NormalizedAgentEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const block = update.content;
      if (block.type !== "text") return [];
      const data = nextTextDelta(state, `msg:${update.messageId ?? "_"}`, block.text);
      return data ? [{ kind: "text-delta", data }] : [];
    }
    case "agent_thought_chunk": {
      const block = update.content;
      if (block.type !== "text") return [];
      const data = nextTextDelta(state, `thought:${update.messageId ?? "_"}`, block.text);
      return data ? [{ kind: "reasoning-delta", data }] : [];
    }
    case "tool_call": {
      if (state.seenToolCallIds.has(update.toolCallId)) return [];
      state.seenToolCallIds.add(update.toolCallId);
      const toolName = acpKindToToolName(update.kind, update.title);
      const input = enrichToolInput(update.rawInput, update.locations);
      state.inputByToolCallId.set(update.toolCallId, input as Record<string, unknown>);
      return [
        {
          kind: "tool-call",
          toolName,
          input,
          callId: update.toolCallId,
        },
      ];
    }
    case "plan": {
      const tasks: NormalizedTask[] = update.entries.map((entry: PlanEntry, index: number) => ({
        id: String(index),
        content: entry.content,
        activeForm: null,
        status: normalizeTaskStatus(entry.status),
        priority: normalizeTaskPriority(entry.priority),
      }));
      return [{ kind: "task-list-update", tasks }];
    }
    case "tool_call_update": {
      const events: NormalizedAgentEvent[] = [];

      const merged = {
        ...(state.inputByToolCallId.get(update.toolCallId) ?? {}),
        ...(enrichToolInput(update.rawInput, update.locations) as Record<string, unknown>),
      };
      state.inputByToolCallId.set(update.toolCallId, merged);

      if (!state.inputUpdatedToolCallIds.has(update.toolCallId) && hasUsableInput(merged)) {
        state.inputUpdatedToolCallIds.add(update.toolCallId);
        events.push({ kind: "tool-call-update", callId: update.toolCallId, input: merged });
      }

      const terminal = update.status === "completed" || update.status === "failed";
      if (terminal && !state.resultEmittedToolCallIds.has(update.toolCallId)) {
        state.resultEmittedToolCallIds.add(update.toolCallId);
        events.push({
          kind: "tool-result",
          callId: update.toolCallId,
          output: extractToolOutput(update.content, merged, update.rawOutput),
          isError: update.status === "failed",
        });
      }

      return events;
    }
    case "usage_update": {
      // `size <= 0` means "unknown window".
      return [
        {
          kind: "usage",
          contextTokens: update.used,
          ...(update.size > 0 ? { contextWindowTokens: update.size } : {}),
        },
      ];
    }
    // current_mode_update, available_commands_update, plan_update/removed,
    // config/session_info, and replayed user_message_chunk have no
    // chat-surface equivalent.
    default:
      return [];
  }
}
