// ── Opencode Part decoder ───────────────────────────────────────────────────
//
// The SDK's `Part` is a discriminated union on `type`:
//   TextPart | (subtask variant) | ReasoningPart | FilePart | ToolPart |
//   StepStartPart | StepFinishPart | SnapshotPart | PatchPart | AgentPart |
//   RetryPart | CompactionPart
//
// We narrow on `part.type` and read each variant's typed fields directly. No
// permissive `[k: string]: unknown` escape hatch — if a new opencode version
// adds a part variant the SDK doesn't yet model, typecheck flags the missing
// case at compile time. That is the load-bearing reason for taking the SDK
// types as the source of truth: silent drift was the main maintenance cost
// of the prior hand-rolled `Part` interface.

import type { Part } from "@opencode-ai/sdk";
import { normalizeToolName } from "@revv/shared";
import type { NormalizedAgentEvent, NormalizedTask } from "./normalized-events";
import {
  classifyToolCallShape,
  normalizeTaskPriority,
  normalizeTaskStatus,
} from "./normalized-events";

/**
 * Split a `provider/modelID` string into the wire shape opencode expects
 * (`{ providerID, modelID }`). Returns undefined when the input doesn't
 * parse — callers omit the `model` field in that case and the daemon
 * picks its configured default.
 */
export function parseOpencodeModel(
  model: string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (model === undefined) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  };
}

/**
 * Extract a human-readable message from opencode's `AssistantMessage.error`
 * union. The daemon returns 200 even when the agent loop fails (model not
 * found, provider auth missing), embedding the failure under
 * `info.error`. Both opencode providers wrap the extracted message in
 * `opencode agent error: …`.
 */
export function extractOpencodeErrorMessage(errObj: {
  readonly name: string;
  readonly data?: unknown;
}): string {
  if (
    errObj.data !== null &&
    typeof errObj.data === "object" &&
    "message" in errObj.data &&
    typeof (errObj.data as { message: unknown }).message === "string"
  ) {
    return (errObj.data as { message: string }).message;
  }
  return errObj.name;
}

/**
 * Pure per-Part decoder. Returns an event (or null if the part should be
 * skipped) plus the new cumulative emitted-length for text/reasoning parts.
 *
 * The cumulative length is how SSE callers deduplicate repeated
 * `message.part.updated` events for the same part. Sync callers
 * (walkOpencodeParts) pass `alreadyEmittedLen: 0` and ignore the return.
 *
 * `deltaHint`: opencode's `message.part.updated` event carries an optional
 * `delta` field — when provided AND we've already emitted something for this
 * partId, we prefer the delta over slicing the full text. When the delta is
 * absent or the part is fresh, we fall back to `part.text.slice(already)`
 * so the user-visible stream stays monotonic.
 */
export function decodeOpencodePart(
  part: Part,
  deltaHint: string | undefined,
  alreadyEmittedLen: number,
): { event: NormalizedAgentEvent | null; newEmittedLen: number } {
  if (part.type === "text") {
    if (part.synthetic === true || part.ignored === true) {
      return { event: null, newEmittedLen: alreadyEmittedLen };
    }
    const chunk = pickChunk(part.text, deltaHint, alreadyEmittedLen);
    if (chunk === null) return { event: null, newEmittedLen: alreadyEmittedLen };
    return {
      event: {
        kind: "text-delta",
        data: chunk,
        partId: part.id,
      },
      newEmittedLen: part.text.length,
    };
  }

  if (part.type === "reasoning") {
    const chunk = pickChunk(part.text, deltaHint, alreadyEmittedLen);
    if (chunk === null) return { event: null, newEmittedLen: alreadyEmittedLen };
    return {
      event: {
        kind: "reasoning-delta",
        data: chunk,
        partId: part.id,
      },
      newEmittedLen: part.text.length,
    };
  }

  if (part.type === "tool") {
    const shape = classifyToolCallShape(part.tool);
    // ToolState is a union (pending/running/completed/error); every
    // variant carries `input`, so the read is safe without narrowing.
    const input = part.state.input;
    // Canonicalise the tool name for the caller. Opencode emits built-in
    // names lowercase (`read`, `grep`); `normalizeToolName` maps them to
    // Claude-canonical form so the four callers can treat the field
    // identically regardless of provider.
    const toolName = normalizeToolName(part.tool);
    return {
      event: {
        kind: "tool-call",
        toolName,
        input,
        callId: part.callID,
        source: shape.source,
        ...(shape.mcpServer !== undefined ? { mcpServer: shape.mcpServer } : {}),
        bareName: shape.bareName,
      },
      newEmittedLen: alreadyEmittedLen,
    };
  }

  // step-start / step-finish / file / snapshot / patch / retry / compaction —
  // ignored. `agent` and `subtask` parts are decoded externally via
  // decodeOpencodeAgentPart because their dedup state is caller-owned.
  return { event: null, newEmittedLen: alreadyEmittedLen };
}

/**
 * Decode a `type: "agent"` or `type: "subtask"` part into a `subagent-start`
 * event. Caller owns the dedup set because opencode resends the part on each
 * `message.part.updated` resend; we want exactly one start per partId.
 *
 * The SDK's `AgentPart` only exposes `name`; the inline `subtask` variant of
 * `Part` carries `prompt`, `description`, `agent`. We treat both as start
 * events and never emit a corresponding `subagent-end` from these parts —
 * opencode doesn't expose a typed completion signal here (the sub-agent's
 * end is implicit when its child message stream stops producing parts).
 */
export function decodeOpencodeAgentPart(
  part: Part,
  state: {
    seenAgentStartPartIds: Set<string>;
  },
): NormalizedAgentEvent | null {
  if (part.type === "subtask") {
    if (state.seenAgentStartPartIds.has(part.id)) return null;
    state.seenAgentStartPartIds.add(part.id);
    return {
      kind: "subagent-start",
      providerCallId: part.id,
      subagentType: part.agent,
      description: part.description,
      prompt: part.prompt,
      source: "opencode",
    };
  }
  if (part.type === "agent") {
    if (state.seenAgentStartPartIds.has(part.id)) return null;
    state.seenAgentStartPartIds.add(part.id);
    return {
      kind: "subagent-start",
      providerCallId: part.id,
      subagentType: part.name,
      description: part.name,
      prompt: "",
      source: "opencode",
    };
  }
  return null;
}

/**
 * Decode a `todo.updated` SSE event body. Returns the snapshot — caller is
 * responsible for content-hashing to suppress no-op resends.
 *
 * The opencode SDK's `Todo` type only carries `{content, status, priority}` —
 * no stable id. We synthesize one by content-hashing (mirrors the Claude
 * `TodoWrite` path) so the UI gets a stable key across re-emissions of the
 * same snapshot. Two semantically distinct todos with identical content
 * collapse into one row, which matches the daemon's own inability to
 * distinguish them.
 */
export function decodeOpencodeTodoUpdate(properties: Record<string, unknown>): NormalizedTask[] {
  const todos = properties.todos;
  if (!Array.isArray(todos)) return [];
  const out: NormalizedTask[] = [];
  for (const raw of todos) {
    if (raw === null || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    const content = typeof t.content === "string" ? (t.content as string) : "";
    if (content.length === 0) continue;
    const providedId =
      typeof t.id === "string" && (t.id as string).length > 0 ? (t.id as string) : null;
    out.push({
      id: providedId ?? opencodeTodoHash(content),
      content,
      activeForm: null,
      status: normalizeTaskStatus(t.status),
      priority: normalizeTaskPriority(t.priority),
    });
  }
  return out;
}

/**
 * Deterministic id for opencode todos (the SDK doesn't expose one). Cheap
 * FNV-1a content hash — identical content collapses to one row, which is
 * what we want since the daemon can't tell them apart either.
 */
function opencodeTodoHash(content: string): string {
  let hash = 2166136261;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `opencode-todo-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function pickChunk(
  fullText: string,
  deltaHint: string | undefined,
  already: number,
): string | null {
  if (deltaHint && already > 0) {
    return deltaHint.length > 0 ? deltaHint : null;
  }
  if (fullText.length > already) {
    return fullText.slice(already);
  }
  return null;
}

// ── Opencode synchronous parts walker ───────────────────────────────────────

/**
 * Iterate a fully-realised parts array (the return value of POST
 * /session/:id/message) and emit normalized events. No dedup state — each
 * part is seen exactly once.
 */
export function walkOpencodeParts(
  parts: ReadonlyArray<Part>,
  emit: (ev: NormalizedAgentEvent) => void,
): void {
  for (const part of parts) {
    const { event } = decodeOpencodePart(part, undefined, 0);
    if (event) emit(event);
  }
}

/**
 * Same as `walkOpencodeParts` but threads the SSE subscription's dedup state
 * (per-partId `emittedTextLen` Map + `seenToolPartIds` Set), so this walk
 * acts as a *backstop* after the SSE drain: anything the SSE already streamed
 * is a no-op here, anything SSE missed (because of subscription timing or a
 * dropped connection) gets emitted from the synchronous response body. This
 * is what unsticks chat-opencode in the "no output at all" failure mode where
 * the SSE never managed to receive the first event before `session.prompt`
 * returned with the full transcript.
 */
export function walkOpencodePartsWithState(
  parts: ReadonlyArray<Part>,
  state: {
    emittedTextLen: Map<string, number>;
    seenToolPartIds: Set<string>;
    /**
     * Message IDs we know belong to user messages. Parts carrying these
     * IDs are skipped to prevent opencode's habit of including the user's
     * input in the response body from echoing back as assistant text.
     */
    userMessageIDs?: Set<string>;
    /**
     * The current turn's assistant message ID (from `response.info.id`).
     * When provided, parts whose `messageID` differs are skipped. This is
     * the definitive filter — anything not authored by the assistant
     * message we just asked for is by definition not assistant output.
     */
    assistantMessageID?: string;
    seenAgentStartPartIds?: Set<string>;
    subagentMessageIdMap?: Map<string, string>;
  },
  emit: (ev: NormalizedAgentEvent) => void,
): void {
  const seenAgentStartPartIds = state.seenAgentStartPartIds ?? new Set<string>();
  const subagentMessageIdMap = state.subagentMessageIdMap ?? new Map<string, string>();
  for (const part of parts) {
    // SDK `Part` always carries `messageID` — no optional guard needed.
    // Allow assistant-authored parts AND child-message parts (sub-agent
    // authored) through the assistant-id filter.
    const childMatch = subagentMessageIdMap.has(part.messageID);
    if (
      state.userMessageIDs?.has(part.messageID) ||
      (state.assistantMessageID !== undefined &&
        state.assistantMessageID !== "" &&
        part.messageID !== state.assistantMessageID &&
        !childMatch)
    ) {
      continue;
    }
    if (part.type === "agent" || part.type === "subtask") {
      const ev = decodeOpencodeAgentPart(part, {
        seenAgentStartPartIds,
      });
      if (ev) emit(ev);
      continue;
    }
    if (part.type === "tool") {
      if (state.seenToolPartIds.has(part.id)) continue;
      state.seenToolPartIds.add(part.id);
    }
    const already = state.emittedTextLen.get(part.id) ?? 0;
    const { event, newEmittedLen } = decodeOpencodePart(part, undefined, already);
    if (!event) continue;
    if (event.kind === "text-delta" || event.kind === "reasoning-delta") {
      state.emittedTextLen.set(part.id, newEmittedLen);
    }
    // Stamp sub-agent attribution for tool calls authored by a child msg.
    if (event.kind === "tool-call" && subagentMessageIdMap.has(part.messageID)) {
      const providerCallId = subagentMessageIdMap.get(part.messageID);
      if (providerCallId) {
        emit({ ...event, subagentProviderCallId: providerCallId });
        continue;
      }
    }
    emit(event);
  }
}
