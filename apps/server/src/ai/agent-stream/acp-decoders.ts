// ── ACP session/update decoder ───────────────────────────────────────────────
//
// Pure mapping from ACP (Agent Client Protocol) `session/update` notifications
// to Revv's transport-agnostic `NormalizedAgentEvent` union. The chat,
// walkthrough, recap, and suggestions providers all consume the normalized
// events and map them onto their own output frames, so this is the only place
// ACP wire shapes are interpreted.

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
 * Map an ACP tool `kind` to a canonical tool name the activity classifier and
 * description builder understand. ACP doesn't carry a machine tool name (only a
 * human `title` + a `kind` enum), but the `rawInput` for adapters that wrap a
 * known SDK (e.g. claude-agent-acp) uses that SDK's parameter names, so a
 * canonical name yields correct activity icons + summaries. Unknown kinds fall
 * back to the human title.
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
  /**
   * Tool-call ids whose terminal `tool-result` has been emitted, so repeated
   * terminal `tool_call_update`s (some agents re-send the final frame) don't
   * double-emit the output peek.
   */
  readonly resultEmittedToolCallIds: Set<string>;
  /**
   * Tool-call ids whose late-arriving input (`tool-call-update`) has been
   * emitted, so we back-fill the filename/command exactly once per call.
   */
  readonly inputUpdatedToolCallIds: Set<string>;
  /**
   * Accumulated tool input per call id, merged across the `tool_call` and every
   * `tool_call_update` (rawInput + locations). Edit before/after strings often
   * arrive on a different update than the terminal one, so the result builder
   * reads the merged input rather than just the terminal frame's.
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

/** Cap captured tool output so a giant file read / log dump can't bloat the
 *  SSE frame or the persisted journal. Generous enough for any shell command. */
const MAX_TOOL_OUTPUT_CHARS = 16_000;

function truncateOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (truncated)`;
}

/**
 * Bound a diff side before encoding. Unlike {@link truncateOutput} this appends
 * NO textual marker — a `… (truncated)` line injected into an edit's old/new
 * text would render as a spurious added/removed line in the diff peek. We
 * truncate to a whole line so the diff parser sees clean input.
 */
function truncateDiffSide(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const slice = text.slice(0, MAX_TOOL_OUTPUT_CHARS);
  const lastNl = slice.lastIndexOf("\n");
  return lastNl > 0 ? slice.slice(0, lastNl) : slice;
}

/**
 * Flatten an ACP `tool_call_update`'s `content`/`rawOutput` into the activity's
 * `output`. A file-edit `diff` block is captured as a structured (sentinel-
 * tagged JSON) old/new pair via the shared {@link encodeToolDiffOutput} so the
 * UI can render a true diff + LOC counts; everything else is best-effort
 * display text (text blocks concatenated; embedded terminals skipped;
 * `rawOutput` as a last resort).
 */
function diffJson(path: string, oldText: string, newText: string): string {
  return encodeToolDiffOutput(path, truncateDiffSide(oldText), truncateDiffSide(newText));
}

/**
 * Recover an edit's before/after from the tool *input* when the agent doesn't
 * emit a `diff` content block. Claude's Edit uses `old_string`/`new_string`;
 * opencode uses `oldString`/`newString`. Returns null for non-edit inputs.
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

function extractToolOutput(
  content: ToolCallContent[] | null | undefined,
  rawInput: unknown,
  rawOutput: unknown,
): string {
  // Prefer a real diff content block, then reconstruct from the edit input.
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
 * Build the tool-call input, back-filling a file path from the ACP `locations`
 * collection when `rawInput` doesn't carry one. Some adapters (claude-agent-acp)
 * send the initial `tool_call` notification with an empty/partial `rawInput` —
 * the touched file only shows up in `locations` (and a later `tool_call_update`).
 * Since we build the activity (and its summary + filename) off this first
 * notification, we fold the location path into the input so Read/Edit/Write
 * cards render their filename instead of a bare "Read".
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

/** Whether an enriched tool input carries a renderable detail (file / command). */
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
  if (chunk === prev) return ""; // full restatement of what we already streamed
  if (prev.length > 0 && chunk.startsWith(prev)) {
    state.emittedTextByKey.set(key, chunk);
    return chunk.slice(prev.length); // cumulative chunk
  }
  state.emittedTextByKey.set(key, prev + chunk);
  return chunk; // fresh incremental delta
}

/**
 * Decode one ACP `session/update` payload into zero or more normalized events.
 * Variants without a chat-surface equivalent (usage, mode/command updates,
 * tool-call status updates, replayed user-message chunks) decode to `[]`.
 */
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
          source: "builtin",
          bareName: toolName,
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
      return [{ kind: "task-list-update", tasks, source: "acp" }];
    }
    case "tool_call_update": {
      const events: NormalizedAgentEvent[] = [];

      // Accumulate input across updates — edit before/after strings often land
      // on a different update than the terminal one.
      const merged = {
        ...(state.inputByToolCallId.get(update.toolCallId) ?? {}),
        ...(enrichToolInput(update.rawInput, update.locations) as Record<string, unknown>),
      };
      state.inputByToolCallId.set(update.toolCallId, merged);

      // Late-arriving input: some adapters send the initial `tool_call` with an
      // empty `rawInput`/`locations` and only populate them here. Back-fill the
      // activity's filename/command (and payload) once per call id.
      if (!state.inputUpdatedToolCallIds.has(update.toolCallId) && hasUsableInput(merged)) {
        state.inputUpdatedToolCallIds.add(update.toolCallId);
        events.push({ kind: "tool-call-update", callId: update.toolCallId, input: merged });
      }

      // Tool output lands here once the call reaches a terminal status. Emit a
      // single `tool-result` per call id so the UI can attach a clickable
      // output peek (Bash stdout / edit diff) to the matching activity.
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
      // Context-window occupancy. ACP reports only `used`/`size` (no
      // input/output/cache throughput), so this drives the occupancy gauge
      // only. `size <= 0` means "unknown window" — omit it.
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
    // chat-surface equivalent in v1.
    default:
      return [];
  }
}
