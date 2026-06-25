// ── ACP session/update decoder ───────────────────────────────────────────────
//
// Pure mapping from ACP (Agent Client Protocol) `session/update` notifications
// to Revv's transport-agnostic `NormalizedAgentEvent` union. The chat,
// walkthrough, recap, and suggestions providers all consume the normalized
// events and map them onto their own output frames, so this is the only place
// ACP wire shapes are interpreted.

import type { PlanEntry, SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";
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
  /** Text already emitted per message, keyed `msg:<id>` / `thought:<id>`. */
  readonly emittedTextByKey: Map<string, string>;
}

export function makeAcpDecodeState(): AcpDecodeState {
  return { seenToolCallIds: new Set(), emittedTextByKey: new Map() };
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
      return [
        {
          kind: "tool-call",
          toolName,
          input: update.rawInput ?? {},
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
    // tool_call_update, current_mode_update, available_commands_update,
    // plan_update/removed, config/session_info, and replayed
    // user_message_chunk have no chat-surface equivalent in v1.
    default:
      return [];
  }
}
