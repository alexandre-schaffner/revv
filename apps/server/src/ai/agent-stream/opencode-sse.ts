// ── Opencode question events (runtime-only, v1 SDK doesn't type them) ──────

import type { Event, Part } from "@opencode-ai/sdk";
import { disableBunTimeout } from "../../constants";
import { debug, logError } from "../../logger";
import type { OpencodeClient } from "../../services/OpencodeSupervisor";
import type { NormalizedAgentEvent, NormalizedTask } from "./normalized-events";
import {
  decodeOpencodeAgentPart,
  decodeOpencodePart,
  decodeOpencodeTodoUpdate,
} from "./opencode-decoders";

interface OpencodeQuestionInfo {
  question: string;
  header: string;
  options: ReadonlyArray<{ label: string; description: string }>;
  multiple?: boolean;
  custom?: boolean;
}

interface OpencodeQuestionRequestPayload {
  id: string;
  sessionID: string;
  questions: ReadonlyArray<OpencodeQuestionInfo>;
  tool?: { messageID: string; callID: string };
}

interface OpencodeQuestionRepliedPayload {
  sessionID: string;
  requestID: string;
  answers: ReadonlyArray<ReadonlyArray<string>>;
}

interface OpencodeQuestionRejectedPayload {
  sessionID: string;
  requestID: string;
}

function handleQuestionEvent(
  type: "question.asked" | "question.replied" | "question.rejected",
  properties: unknown,
  sessionId: string,
  lastQuestionsByRequestId: Map<string, ReadonlyArray<import("@revv/shared").NormalizedQuestion>>,
  emit: (ev: NormalizedAgentEvent) => void,
): void {
  if (!properties || typeof properties !== "object") return;
  if (type === "question.asked") {
    const req = properties as OpencodeQuestionRequestPayload;
    if (req.sessionID !== sessionId) return;
    const questions: import("@revv/shared").NormalizedQuestion[] = [];
    for (const q of req.questions ?? []) {
      const options = (q.options ?? []).map((o) => ({
        label: o.label,
        description: o.description,
      }));
      if (q.question.length === 0 || options.length === 0) continue;
      questions.push({
        question: q.question,
        header: q.header,
        // opencode `multiple` defaults to true per its schema —
        // preserve that default if the field is absent.
        multiSelect: q.multiple ?? true,
        // opencode `custom` defaults to true per its schema.
        allowCustom: q.custom ?? true,
        options,
      });
    }
    if (questions.length === 0) return;
    lastQuestionsByRequestId.set(req.id, questions);
    const event: NormalizedAgentEvent = {
      kind: "user-question-asked",
      providerRequestId: req.id,
      source: "opencode",
      questions,
      previewFormat: "markdown",
      ...(req.tool?.callID ? { providerToolCallId: req.tool.callID } : {}),
    };
    emit(event);
    return;
  }
  if (type === "question.replied") {
    const r = properties as OpencodeQuestionRepliedPayload;
    if (r.sessionID !== sessionId) return;
    // Reconstruct Record<questionText, labels[]> from the original
    // questions list. Opencode replies with an Array<Array<string>>
    // in the same order as the questions; merge by index.
    const original = lastQuestionsByRequestId.get(r.requestID);
    const answers: Record<string, ReadonlyArray<string>> = {};
    if (original) {
      for (let i = 0; i < original.length; i += 1) {
        const q = original[i]!;
        const labels = r.answers[i] ?? [];
        answers[q.question] = labels;
      }
      lastQuestionsByRequestId.delete(r.requestID);
    }
    emit({
      kind: "user-question-resolved",
      providerRequestId: r.requestID,
      source: "opencode",
      status: "answered",
      answers,
    });
    return;
  }
  // question.rejected
  const r = properties as OpencodeQuestionRejectedPayload;
  if (r.sessionID !== sessionId) return;
  lastQuestionsByRequestId.delete(r.requestID);
  emit({
    kind: "user-question-resolved",
    providerRequestId: r.requestID,
    source: "opencode",
    status: "rejected",
  });
}

// ── Opencode SSE subscription ───────────────────────────────────────────────

/**
 * Subscribe to `/global/event` SSE via the SDK and emit normalized events as
 * `message.part.updated` frames arrive. Returns when the subscription is
 * aborted via `signal` OR when the daemon closes the stream.
 *
 * We use `client.global.event()` (not `client.event.subscribe()`) because
 * historically opencode's `/event` endpoint emits a single `server.connected`
 * frame then terminates the chunked response body, while `/global/event` is
 * the long-lived stream that carries every `message.part.updated`,
 * `todo.updated`, `session.error`, etc. across all sessions. We filter to
 * the current session's events client-side.
 *
 * Owns:
 *   - The per-partId emitted-length Map used by `decodeOpencodePart` for
 *     text/reasoning dedup across repeated frames.
 *   - A `seenToolPartIds` set so a tool-call event fires exactly once per
 *     `pending → running → completed` lifecycle (the daemon resends the
 *     part on each state transition).
 *   - The load-bearing 100ms drain: SSE callers (chat-opencode) used to do
 *     `await new Promise(r => setTimeout(r, 100)); subscribeAbort.abort()`
 *     after their session.prompt resolved, to let trailing
 *     `message.part.updated` events arrive before tearing down. That drain
 *     lives here now — callers just abort and await this promise; we sleep
 *     for `drainMs` (default 100ms) before actually unhooking from the
 *     daemon's event stream.
 */
export async function subscribeOpencodeStream(
  client: OpencodeClient,
  sessionId: string,
  signal: AbortSignal,
  emit: (ev: NormalizedAgentEvent) => void,
  opts?: {
    drainMs?: number;
    /**
     * Optional caller-owned dedup state. When provided, the SSE
     * subscription and the post-hoc `walkOpencodePartsWithState` walk
     * share the same `seenToolPartIds` / `emittedTextLen` maps so the
     * backstop walk only emits parts SSE missed. Defaults to fresh
     * local state when omitted.
     */
    emittedTextLen?: Map<string, number>;
    seenToolPartIds?: Set<string>;
    /**
     * Caller-owned set of message IDs known to belong to user messages.
     * The SSE handler augments it whenever a `message.updated` event
     * arrives with `role === "user"`, and skips any `message.part.updated`
     * frame whose `part.messageID` is in the set. Share with the backstop
     * walk so user parts the daemon includes in `response.parts` are
     * filtered there too. Defaults to a fresh local set when omitted.
     *
     * Opencode posts the user message before kicking off inference, so
     * the `message.updated` for the user message reliably lands before
     * any assistant `message.part.updated` events arrive — no race.
     */
    userMessageIDs?: Set<string>;
    /**
     * Per-partId dedup for sub-agent start emission. Opencode resends
     * `agent`/`subtask` parts on state transitions; we only emit one
     * `subagent-start` per part. Shared with the backstop walk so the
     * synchronous response body doesn't re-emit.
     */
    seenAgentStartPartIds?: Set<string>;
    /**
     * Last task-list snapshot hash, used to suppress no-op `todo.updated`
     * resends. Caller-owned so the backstop walk can share if needed.
     */
    lastTodoSnapshotHash?: { value: string | null };
    /**
     * Caller-owned map: opencode `QuestionRequest.id` → the original
     * questions list. Populated on `question.asked`, read on
     * `question.replied` to reconstruct a `Record<questionText, labels[]>`
     * shape from opencode's `Array<Array<string>>` reply order.
     */
    lastQuestionsByRequestId?: Map<
      string,
      ReadonlyArray<import("@revv/shared").NormalizedQuestion>
    >;
    /**
     * Map from a sub-agent's child messageID to the parent invocation's
     * providerCallId. The SSE handler populates this when a `subtask` or
     * `agent` part arrives; subsequent tool parts whose messageID hits
     * the map get stamped with `subagentProviderCallId` so the UI nests
     * them under the parent invocation card.
     *
     * Heuristic-only — opencode doesn't always expose the child-message
     * id on the parent part. Unstamped tool parts render at top level.
     */
    subagentMessageIdMap?: Map<string, string>;
    /**
     * Fires whenever a `message.updated` event arrives for an assistant
     * message in the current session, carrying that message's running
     * `tokens` snapshot (input / output / reasoning / cache.{read,write}).
     * Callers (walkthrough provider) translate this into a `usage` event
     * so the BottomBar updates live mid-turn rather than only when the
     * full agent turn resolves. No throttling here — callers should
     * throttle if needed for downstream cost.
     */
    onAssistantTokens?: (tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    }) => void;
  },
): Promise<void> {
  const emittedTextLen = opts?.emittedTextLen ?? new Map<string, number>();
  const seenToolPartIds = opts?.seenToolPartIds ?? new Set<string>();
  const userMessageIDs = opts?.userMessageIDs ?? new Set<string>();
  const seenAgentStartPartIds = opts?.seenAgentStartPartIds ?? new Set<string>();
  const lastTodoSnapshotHash = opts?.lastTodoSnapshotHash ?? {
    value: null as string | null,
  };
  const subagentMessageIdMap = opts?.subagentMessageIdMap ?? new Map<string, string>();
  const lastQuestionsByRequestId =
    opts?.lastQuestionsByRequestId ??
    new Map<string, ReadonlyArray<import("@revv/shared").NormalizedQuestion>>();
  const drainMs = opts?.drainMs ?? 100;

  // Compose an inner signal so we can run a final 100ms drain after the
  // caller's abort fires. The SDK-driven SSE iterator keeps reading until
  // `innerAbort.abort()`; the caller's `signal` triggers the drain timer
  // instead of immediately tearing down.
  const innerAbort = new AbortController();
  const onCallerAbort = () => {
    setTimeout(() => innerAbort.abort(), drainMs);
  };
  if (signal.aborted) {
    onCallerAbort();
  } else {
    signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const handleEvent = (ev: Event): void => {
    // Question events (question.asked / .replied / .rejected) live in the
    // opencode daemon at runtime but aren't yet present in the v1 SDK's
    // typed `Event` union (they exist in v2). We intercept them here via
    // a runtime type check so the rest of the typed switch stays sound.
    // When the SDK types catch up, this block can move into the switch.
    const dynamicEv = ev as { type: string; properties: unknown };
    if (
      dynamicEv.type === "question.asked" ||
      dynamicEv.type === "question.replied" ||
      dynamicEv.type === "question.rejected"
    ) {
      handleQuestionEvent(
        dynamicEv.type,
        dynamicEv.properties,
        sessionId,
        lastQuestionsByRequestId,
        emit,
      );
      return;
    }
    switch (ev.type) {
      case "message.updated": {
        // Learn which message IDs belong to user messages so we can skip
        // their parts. Opencode creates the user message before kicking
        // off inference, so this fires before any assistant
        // `message.part.updated` events — race-free in practice.
        const info = ev.properties.info;
        if (info.role === "user") {
          userMessageIDs.add(info.id);
        } else if (info.role === "assistant" && info.sessionID === sessionId) {
          // Assistant messages carry a running `tokens` snapshot that
          // the daemon updates as output streams. Forward it to the
          // caller so they can broadcast a `usage` event for live
          // BottomBar updates mid-turn (without waiting for the full
          // session.prompt to resolve).
          opts?.onAssistantTokens?.(info.tokens);
        }
        return;
      }
      case "todo.updated": {
        if (ev.properties.sessionID !== sessionId) return;
        const tasks = decodeOpencodeTodoUpdate({
          todos: ev.properties.todos,
        });
        const hash = hashTaskSnapshot(tasks);
        if (hash !== lastTodoSnapshotHash.value) {
          lastTodoSnapshotHash.value = hash;
          emit({ kind: "task-list-update", tasks, source: "opencode" });
        }
        return;
      }
      case "message.part.updated": {
        const part = ev.properties.part;
        if (part.sessionID !== sessionId) return;

        // Skip parts belonging to user messages. Without this, opencode's
        // re-emission of the user's input as a `text` part gets decoded as
        // an assistant text-delta and echoed back into the chat bubble.
        if (userMessageIDs.has(part.messageID)) return;

        // Step-finish parts arrive between tool calls and carry the
        // running token total for the message so far. Surface them via
        // onAssistantTokens — gives the BottomBar a more reliable
        // mid-turn update cadence than `message.updated` alone, since
        // step boundaries map one-to-one with tool calls during
        // walkthrough generation. The dedicated decoder ignores this
        // part type for normalized events.
        if (part.type === "step-finish") {
          opts?.onAssistantTokens?.(part.tokens);
          return;
        }

        // Agent / subtask parts: route through the dedicated decoder
        // that owns the start dedup.
        if (part.type === "agent" || part.type === "subtask") {
          const subEv = decodeOpencodeAgentPart(part, {
            seenAgentStartPartIds,
          });
          if (subEv) emit(subEv);
          return;
        }

        // Tool parts fire exactly once per partId regardless of dedup
        // state. Run that filter before invoking decodeOpencodePart so
        // the pure decoder stays state-free.
        if (part.type === "tool") {
          if (seenToolPartIds.has(part.id)) return;
          seenToolPartIds.add(part.id);
        }

        const already = emittedTextLen.get(part.id) ?? 0;
        const { event, newEmittedLen } = decodeOpencodePart(part, ev.properties.delta, already);
        if (event) {
          if (event.kind === "text-delta" || event.kind === "reasoning-delta") {
            emittedTextLen.set(part.id, newEmittedLen);
          } else if (event.kind === "tool-call") {
            const providerCallId = subagentMessageIdMap.get(part.messageID);
            const stamped = providerCallId
              ? { ...event, subagentProviderCallId: providerCallId }
              : event;
            debug(
              "agent-stream",
              "emit tool-call:",
              event.toolName,
              "source:",
              event.source,
              "bareName:",
              event.bareName,
            );
            emit(stamped);
            return;
          }
          emit(event);
        } else if (part.type === "tool") {
          // Logged so REV_DEBUG=1 can spot tool parts we silently
          // dropped — should be rare against the typed SDK Part
          // since the decoder narrows on `type` exhaustively.
          debug("agent-stream", "tool part decoded to null event", "tool:", part.tool);
        }
        return;
      }
      case "session.error": {
        if (ev.properties.sessionID !== undefined && ev.properties.sessionID !== sessionId) {
          return;
        }
        const errObj = ev.properties.error;
        const msg =
          (errObj && "data" in errObj && typeof errObj.data === "object"
            ? (errObj.data as { message?: unknown }).message
            : undefined) ??
          (errObj && "name" in errObj && typeof errObj.name === "string"
            ? errObj.name
            : undefined) ??
          "Agent error";
        emit({ kind: "error", message: String(msg) });
        return;
      }
      default:
        // Other event types (file.edited, session.created, lsp.*,
        // permission.*, pty.*, tui.*, etc.) are not consumed by the
        // chat or walkthrough drivers.
        return;
    }
  };

  try {
    const result = await client.global.event({
      fetch: (req) => {
        // Disable Bun's 5-minute idle timeout for the SSE long-poll.
        // Without this, post-300s tool calls are silently dropped.
        disableBunTimeout(req);
        return fetch(req);
      },
      signal: innerAbort.signal,
    });
    for await (const globalEvent of result.stream) {
      if (innerAbort.signal.aborted) break;
      handleEvent(globalEvent.payload);
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    // Promote to logError so the failure is visible without REV_DEBUG=1.
    // A dropped SSE subscription mid-turn is the difference between "agent
    // is silent" and "agent is dead" from the user's perspective.
    logError(
      "agent-stream",
      "subscribeOpencodeStream error:",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    if (!signal.aborted) signal.removeEventListener("abort", onCallerAbort);
  }
}

// ── Sub-agent + task helpers ────────────────────────────────────────────────

/**
 * Stable hash of a task-list snapshot. The opencode daemon resends
 * `todo.updated` events even when the contents are unchanged; we content-hash
 * to skip those resends and only emit `task-list-update` on real diffs.
 */
function hashTaskSnapshot(tasks: ReadonlyArray<NormalizedTask>): string {
  const parts: string[] = [];
  for (const t of tasks) {
    parts.push(`${t.id}|${t.content}|${t.activeForm ?? ""}|${t.status}|${t.priority ?? ""}`);
  }
  const joined = parts.join("\n");
  let hash = 2166136261;
  for (let i = 0; i < joined.length; i += 1) {
    hash ^= joined.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
