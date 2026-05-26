// ── Claude SDK content-block walker ─────────────────────────────────────────

import type { WalkthroughTokenUsage } from "@revv/shared";
import type { NormalizedAgentEvent, NormalizedTask } from "./normalized-events";
import {
  classifyToolCallShape,
  normalizeTaskPriority,
  normalizeTaskStatus,
} from "./normalized-events";

/**
 * Minimal shape of the Claude Agent SDK message stream that we care about.
 * The full SDK type is broader; this captures only the fields we read so
 * that the walker doesn't carry a dependency on the SDK's exact types.
 */
interface ClaudeMessage {
  type: string;
  // Present on both `assistant` and `user` messages — sub-agent activity
  // inside the parent stream carries this so callers can attribute it back
  // to the Agent tool_use that spawned it. (`Agent` was named `Task` in
  // pre-0.3.x SDK builds; the walker only depends on the runtime id, not
  // the tool name, so the rename was a no-op here.)
  parent_tool_use_id?: string | null;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      data?: string;
      name?: string;
      id?: string;
      input?: unknown;
      // On `tool_result` blocks (sent in `user` messages):
      tool_use_id?: string;
      is_error?: boolean;
      // `content` on tool_result can be either a string or a list of
      // content blocks. We accept both shapes; the walker normalizes.
      content?: string | Array<{ type: string; text?: string }>;
    }>;
    // Cumulative token usage for THIS turn (one model inference call).
    // Populated on `assistant` SDK messages by the Claude Agent SDK; the
    // walker sums these across turns to produce the running session total.
    // Field names mirror the Anthropic API shape.
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  // `stream_event` shape (SDKPartialAssistantMessage). Populated only when
  // the caller opted into partial messages via `includePartialMessages:
  // true`. Each event is a raw Claude API stream event so the walker can
  // emit per-token text/thinking deltas instead of waiting for the full
  // `assistant` message at the end of each turn.
  event?: {
    type: string;
    index?: number;
    delta?: {
      type: string;
      text?: string;
      thinking?: string;
    };
    // `message_start` events nest the initial response info under
    // `message.usage` (full usage shape including cache reads/writes).
    // `message_delta` events carry running counts directly on `event.usage`
    // (typically only `output_tokens`).
    message?: {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  subtype?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * Walk an `AsyncIterable` of Claude SDK messages and emit normalized events.
 *
 * Block translation:
 *   - `text`              → `text-delta`
 *   - `thinking`          → `reasoning-delta` (data in `.thinking`)
 *   - `redacted_thinking` → `reasoning-delta` with a sentinel string in the
 *                            data field (the actual content is encrypted; we
 *                            still surface *something* so guard heartbeats fire
 *                            and downstream UIs can render a placeholder)
 *   - `tool_use`          → `tool-call`
 *
 * When the caller opts into `includePartialMessages: true` on the SDK, the
 * walker also handles `stream_event` messages: `content_block_delta` events
 * are emitted as fine-grained `text-delta` / `reasoning-delta` chunks (the
 * model's natural per-token cadence), and the corresponding text/thinking
 * blocks in the trailing `assistant` message are skipped so the same content
 * isn't emitted twice. When partial messages are NOT enabled, no
 * `stream_event` messages arrive and the dedup tracking stays empty — the
 * full block fires from the `assistant` message exactly as before.
 *
 * Returns the final `WalkthroughTokenUsage` parsed from the SDK's terminal
 * `result` message — `null` if the stream ended without one. Callers that
 * don't care (chat) can ignore the return value.
 *
 * `opts.onMessage` fires once per SDK message *before* the walker decodes its
 * content. The Claude SDK exposes its session id via the `query()` async
 * generator (not on the message itself), so the chat caller's session-id
 * polling stays where it is; this hook exists for any future caller that
 * needs raw SDK access without re-iterating the stream.
 */
export async function walkClaudeMessages(
  iter: AsyncIterable<unknown>,
  emit: (ev: NormalizedAgentEvent) => void,
  opts?: { onMessage?: (msg: unknown) => void | Promise<void> },
): Promise<WalkthroughTokenUsage | null> {
  let tokenUsage: WalkthroughTokenUsage | null = null;

  // Tracks active Agent (sub-agent) invocations by tool_use.id so we can:
  //   (a) emit `subagent-end` when the matching tool_result arrives, and
  //   (b) stamp nested tool calls with `subagentProviderCallId` even on
  //       SDK builds where `parent_tool_use_id` is missing from the
  //       nested message (stack-based fallback).
  const activeSubagentCallIds = new Set<string>();

  // Structured-task state (TaskCreate / TaskUpdate / TaskGet / TaskList).
  // The SDK's task surface is CRUD-style, not snapshot-style, so the
  // walker maintains the canonical list locally and re-emits a full
  // `task-list-update` snapshot after each mutation — the consumer
  // shape stays identical to the TodoWrite path. `claudeTasks` is keyed
  // by the SDK-assigned task id, learned from the `TaskCreate`
  // tool_result body. Until that result arrives, the create params live
  // in `pendingClaudeTaskCreates` keyed by the tool_use.id.
  const claudeTasks = new Map<string, NormalizedTask>();
  const pendingClaudeTaskCreates = new Map<
    string,
    { subject: string; activeForm: string | null }
  >();
  const emitClaudeTaskSnapshot = (): void => {
    emit({
      kind: "task-list-update",
      tasks: Array.from(claudeTasks.values()),
      source: "claude",
    });
  };

  // Content-block indices in the CURRENT in-progress assistant message
  // that we've already emitted as deltas via `stream_event` messages.
  // Cleared on `message_start` (new turn) and again after we process the
  // trailing `assistant` message. When `includePartialMessages: false`,
  // this stays empty and assistant-block emission proceeds as before.
  const streamedContentBlockIndices = new Set<number>();

  for await (const raw of iter) {
    if (opts?.onMessage) {
      await opts.onMessage(raw);
    }
    const message = raw as ClaudeMessage;

    if (message.type === "stream_event") {
      const event = message.event;
      if (!event || typeof event.type !== "string") continue;
      if (event.type === "message_start") {
        // New assistant message starting — reset the dedup tracker.
        streamedContentBlockIndices.clear();
        continue;
      }
      if (event.type === "content_block_delta" && typeof event.index === "number" && event.delta) {
        const delta = event.delta;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          if (delta.text.length > 0) {
            emit({ kind: "text-delta", data: delta.text });
          }
          streamedContentBlockIndices.add(event.index);
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          if (delta.thinking.length > 0) {
            emit({ kind: "reasoning-delta", data: delta.thinking });
          }
          streamedContentBlockIndices.add(event.index);
        }
        // `input_json_delta` / `citations_delta` / `signature_delta`
        // are intentionally ignored — tool inputs are surfaced from
        // the final `assistant` message once the JSON parses cleanly.
      }
      continue;
    }

    if (message.type === "assistant" && message.message?.content) {
      // Sub-agent attribution: if this assistant message carries a
      // parent_tool_use_id we know the agent emitting it is an Agent
      // sub-agent. Stamp every tool-call inside.
      const parentId =
        typeof message.parent_tool_use_id === "string" &&
        activeSubagentCallIds.has(message.parent_tool_use_id)
          ? message.parent_tool_use_id
          : null;
      // Fallback: if SDK build doesn't surface parent_tool_use_id on
      // nested messages, attribute to *any* known-active Agent. Safe
      // for the foreground case because Claude only runs one Agent at
      // a time per turn; if `run_in_background: true` ever lands in
      // Revv's chat surface this stops being safe and the SDK's
      // `parent_tool_use_id` must be relied on.
      const fallbackParentId =
        parentId === null && activeSubagentCallIds.size > 0
          ? // Pick the first (only) active one
            (activeSubagentCallIds.values().next().value ?? null)
          : null;
      const attribution = parentId ?? fallbackParentId;

      for (let blockIdx = 0; blockIdx < message.message.content.length; blockIdx += 1) {
        const block = message.message.content[blockIdx];
        if (!block) continue;
        // Skip text/thinking blocks already streamed via `stream_event`
        // deltas — re-emitting would duplicate every chunk in the
        // assistant bubble. Tool blocks always go through (we only
        // have their complete `input` once the assistant message
        // arrives).
        if (
          streamedContentBlockIndices.has(blockIdx) &&
          (block.type === "text" || block.type === "thinking" || block.type === "redacted_thinking")
        ) {
          continue;
        }
        if (block.type === "text" && typeof block.text === "string") {
          emit({ kind: "text-delta", data: block.text });
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          emit({ kind: "reasoning-delta", data: block.thinking });
        } else if (block.type === "redacted_thinking") {
          emit({
            kind: "reasoning-delta",
            data: "[redacted thinking]",
          });
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          // Surface-specific tool routing for TodoWrite / TaskCreate-family
          // / ExitPlanMode / Agent. These don't flow through the generic
          // tool-call event — they have their own normalized shapes.
          if (block.name === "TodoWrite") {
            const tasks = parseClaudeTodoWriteInput(block.input);
            emit({
              kind: "task-list-update",
              tasks,
              source: "claude",
            });
            continue;
          }
          if (block.name === "TaskCreate") {
            // The create params land in our state now, but the SDK
            // assigns the taskId asynchronously and returns it in the
            // matching tool_result. We can't render the new task until
            // we know its id (TaskUpdate references taskId), so park
            // the params in `pendingClaudeTaskCreates` and emit the
            // snapshot once the tool_result arrives.
            if (typeof block.id === "string") {
              const info = parseClaudeTaskCreateInput(block.input);
              if (info.subject.length > 0) {
                pendingClaudeTaskCreates.set(block.id, {
                  subject: info.subject,
                  activeForm: info.activeForm,
                });
              }
            }
            continue;
          }
          if (block.name === "TaskUpdate") {
            const update = parseClaudeTaskUpdateInput(block.input);
            if (update.taskId.length > 0) {
              const existing = claudeTasks.get(update.taskId);
              if (existing) {
                // `deleted` is a soft delete — drop the row.
                if (update.status === "deleted") {
                  claudeTasks.delete(update.taskId);
                } else {
                  claudeTasks.set(update.taskId, {
                    id: update.taskId,
                    content: update.subject ?? existing.content,
                    activeForm: update.activeForm ?? existing.activeForm,
                    status: update.status ?? existing.status,
                    priority: existing.priority,
                  });
                }
                emitClaudeTaskSnapshot();
              }
            }
            continue;
          }
          if (block.name === "TaskGet" || block.name === "TaskList") {
            // Pure reads — no state change, no event.
            continue;
          }
          if (block.name === "ExitPlanMode") {
            const plan = extractClaudePlanMarkdown(block.input);
            if (plan !== null && typeof block.id === "string") {
              emit({
                kind: "plan-presented",
                markdown: plan,
                providerPlanId: block.id,
                source: "claude",
              });
            }
            continue;
          }
          if (block.name === "Agent" && typeof block.id === "string") {
            const info = parseClaudeAgentInput(block.input);
            activeSubagentCallIds.add(block.id);
            emit({
              kind: "subagent-start",
              providerCallId: block.id,
              subagentType: info.subagentType,
              description: info.description,
              prompt: info.prompt,
              source: "claude",
            });
            continue;
          }

          const shape = classifyToolCallShape(block.name);
          emit({
            kind: "tool-call",
            toolName: block.name,
            input: block.input,
            ...(typeof block.id === "string" ? { callId: block.id } : {}),
            source: shape.source,
            ...(shape.mcpServer !== undefined ? { mcpServer: shape.mcpServer } : {}),
            bareName: shape.bareName,
            ...(attribution !== null ? { subagentProviderCallId: attribution } : {}),
          });
        }
      }
      // Done with this assistant message — clear the per-message
      // streamed-index tracker so a follow-up assistant message in
      // the same turn (multi-step tool use) starts fresh.
      streamedContentBlockIndices.clear();
    } else if (message.type === "user" && message.message?.content) {
      // `user` messages carry tool_result blocks. Two correlations
      // happen here:
      //   - active Agent invocation → emit `subagent-end`
      //   - pending TaskCreate → promote the pending row into
      //     `claudeTasks` under the SDK-assigned taskId and emit a
      //     fresh `task-list-update` snapshot.
      for (const block of message.message.content) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;

        if (activeSubagentCallIds.has(block.tool_use_id)) {
          const resultText = extractClaudeToolResultText(block.content);
          emit({
            kind: "subagent-end",
            providerCallId: block.tool_use_id,
            result: resultText,
            ok: block.is_error !== true,
            source: "claude",
          });
          activeSubagentCallIds.delete(block.tool_use_id);
          continue;
        }

        const pending = pendingClaudeTaskCreates.get(block.tool_use_id);
        if (pending) {
          pendingClaudeTaskCreates.delete(block.tool_use_id);
          if (block.is_error === true) continue;
          const taskId = extractClaudeTaskCreateTaskId(block.content);
          if (taskId !== null) {
            claudeTasks.set(taskId, {
              id: taskId,
              content: pending.subject,
              activeForm: pending.activeForm,
              status: "pending",
              priority: null,
            });
            emitClaudeTaskSnapshot();
          }
        }
      }
    } else if (message.type === "result" && message.usage) {
      tokenUsage = {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
      };
    }
  }

  return tokenUsage;
}

// ── Claude tool-input decoders ─────────────────────────────────────────────

interface ClaudeTodoInput {
  content?: string;
  activeForm?: string;
  status?: string;
  priority?: string;
}

/**
 * Parse Claude's `TodoWrite` tool input into a normalized snapshot. The SDK
 * doesn't supply per-todo ids, so we content-hash `(content + activeForm)`
 * for stability across snapshots — identical entries collapse, which is
 * acceptable for a display list.
 */
function parseClaudeTodoWriteInput(input: unknown): NormalizedTask[] {
  if (input === null || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const todos = obj.todos;
  if (!Array.isArray(todos)) return [];

  const out: NormalizedTask[] = [];
  for (const raw of todos) {
    if (raw === null || typeof raw !== "object") continue;
    const t = raw as ClaudeTodoInput;
    const content = typeof t.content === "string" ? t.content : "";
    if (content.length === 0) continue;
    const activeForm =
      typeof t.activeForm === "string" && t.activeForm.length > 0 ? t.activeForm : null;
    const status = normalizeTaskStatus(t.status);
    const priority = normalizeTaskPriority(t.priority);
    out.push({
      id: claudeTodoHash(content, activeForm),
      content,
      activeForm,
      status,
      priority,
    });
  }
  return out;
}

/**
 * Deterministic id for Claude todos (no SDK-provided id). Cheap FNV-1a hash
 * — collisions only matter if two semantically distinct todos render
 * identical content + activeForm, which would already render as a single
 * row to the user anyway.
 */
function claudeTodoHash(content: string, activeForm: string | null): string {
  const input = `${content}\x00${activeForm ?? ""}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Render as hex; pad to 8 chars for stable length.
  return `claude-todo-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Normalize a Claude `askUserQuestion` tool input to our cross-provider
 * `NormalizedQuestion[]`. Defensive against malformed inputs — the SDK
 * enforces the schema, but a corrupt tool_use block shouldn't crash the
 * driver. Returns an empty array if parsing fails.
 *
 * Schema (per `AskUserQuestionInput`):
 *   { questions: Array<{
 *       question: string;
 *       header: string;
 *       multiSelect: boolean;
 *       options: Array<{ label: string; description: string; preview?: string }>;
 *     }>
 *   }
 *
 * Claude's `askUserQuestion` has no equivalent of opencode's `custom` flag,
 * so `allowCustom` is always false.
 */
export function normalizeClaudeAskUserQuestionInput(
  input: unknown,
): ReadonlyArray<import("@revv/shared").NormalizedQuestion> {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const raw = obj.questions;
  if (!Array.isArray(raw)) return [];
  const out: import("@revv/shared").NormalizedQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const qo = q as Record<string, unknown>;
    const question = typeof qo.question === "string" ? qo.question : "";
    const header = typeof qo.header === "string" ? qo.header : "";
    const multiSelect = qo.multiSelect === true;
    const optionsRaw = qo.options;
    const options: Array<{
      label: string;
      description: string;
      preview?: string;
    }> = [];
    if (Array.isArray(optionsRaw)) {
      for (const o of optionsRaw) {
        if (!o || typeof o !== "object") continue;
        const oo = o as Record<string, unknown>;
        const label = typeof oo.label === "string" ? oo.label : "";
        const description = typeof oo.description === "string" ? oo.description : "";
        const preview = typeof oo.preview === "string" ? oo.preview : undefined;
        if (label.length === 0) continue;
        options.push(
          preview !== undefined ? { label, description, preview } : { label, description },
        );
      }
    }
    if (question.length === 0 || options.length === 0) continue;
    out.push({
      question,
      header,
      multiSelect,
      allowCustom: false,
      options,
    });
  }
  return out;
}

/**
 * `ExitPlanMode.input` per Claude SDK has a single `plan: string` field.
 * Defensive: accept other shapes too.
 */
function extractClaudePlanMarkdown(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const plan = (input as Record<string, unknown>).plan;
  if (typeof plan === "string" && plan.trim().length > 0) return plan;
  return null;
}

/**
 * `Agent.input` per Claude SDK (renamed from `Task` in 0.3.x):
 *   { subagent_type?: string, description: string, prompt: string,
 *     model?, mode?, isolation?, name?, team_name?, run_in_background? }
 * Pre-0.3.x SDKs used `subagentType` (camelCase) and the tool name `Task`.
 * The walker normalises only the three fields that carry into the
 * `subagent-start` event; the rest are forwarded to the SDK but not
 * surfaced to the chat UI.
 */
function parseClaudeAgentInput(input: unknown): {
  subagentType: string;
  description: string;
  prompt: string;
} {
  const fallback = {
    subagentType: "general-purpose",
    description: "Sub-agent task",
    prompt: "",
  };
  if (input === null || typeof input !== "object") return fallback;
  const obj = input as Record<string, unknown>;
  const subagentType =
    (typeof obj.subagent_type === "string" && obj.subagent_type) ||
    (typeof obj.subagentType === "string" && obj.subagentType) ||
    fallback.subagentType;
  const description =
    (typeof obj.description === "string" && obj.description) || fallback.description;
  const prompt = (typeof obj.prompt === "string" && obj.prompt) || fallback.prompt;
  return { subagentType, description, prompt };
}

/**
 * `TaskCreate.input` per Claude SDK 0.3.x:
 *   { subject: string, description: string, activeForm?: string, metadata? }
 * Maps onto the existing `NormalizedTask` shape — `subject` becomes the
 * task `content`. `activeForm` carries through; the SDK's separate
 * `description` is dropped because the chat UI's task row only renders
 * the short label.
 */
function parseClaudeTaskCreateInput(input: unknown): {
  subject: string;
  activeForm: string | null;
} {
  if (input === null || typeof input !== "object") return { subject: "", activeForm: null };
  const obj = input as Record<string, unknown>;
  const subject = typeof obj.subject === "string" ? obj.subject : "";
  const activeForm =
    typeof obj.activeForm === "string" && obj.activeForm.length > 0 ? obj.activeForm : null;
  return { subject, activeForm };
}

/**
 * `TaskUpdate.input` per Claude SDK 0.3.x. We accept the subset of
 * fields that map onto `NormalizedTask`. `addBlocks` / `addBlockedBy` /
 * `owner` / `metadata` are forwarded to the SDK but not surfaced.
 *
 * The SDK exposes a `deleted` pseudo-status for soft deletes — the
 * walker surfaces it as `"deleted"` so the caller drops the row.
 */
function parseClaudeTaskUpdateInput(input: unknown): {
  taskId: string;
  subject?: string;
  activeForm?: string | null;
  status?: NormalizedTask["status"] | "deleted";
} {
  if (input === null || typeof input !== "object") return { taskId: "" };
  const obj = input as Record<string, unknown>;
  const taskId = typeof obj.taskId === "string" ? obj.taskId : "";
  const result: ReturnType<typeof parseClaudeTaskUpdateInput> = { taskId };
  if (typeof obj.subject === "string") result.subject = obj.subject;
  if (typeof obj.activeForm === "string") {
    result.activeForm = obj.activeForm.length > 0 ? obj.activeForm : null;
  }
  if (obj.status === "deleted") {
    result.status = "deleted";
  } else if (obj.status !== undefined) {
    // Only set `status` when the SDK actually supplied one; otherwise
    // `normalizeTaskStatus` would default to `"pending"` and clobber an
    // in_progress/completed row on a partial update.
    result.status = normalizeTaskStatus(obj.status);
  }
  return result;
}

/**
 * Extract the SDK-assigned `task.id` from a `TaskCreate` tool_result.
 * The SDK serializes the result body as JSON text inside the tool_result
 * content; the walker re-parses it to learn the id so subsequent
 * `TaskUpdate` calls (which reference the id) can be applied.
 */
function extractClaudeTaskCreateTaskId(
  content: string | Array<{ type: string; text?: string }> | undefined,
): string | null {
  const text = extractClaudeToolResultText(content).trim();
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const task = (parsed as Record<string, unknown>).task;
  if (task === null || typeof task !== "object") return null;
  const id = (task as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Tool result content can be a plain string OR a list of content blocks.
 * Concatenate text blocks into a single string for the sub-agent's result.
 */
function extractClaudeToolResultText(
  content: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("");
}
