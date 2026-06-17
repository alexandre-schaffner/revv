// ── Codex SDK event walker ──────────────────────────────────────────────────
//
// Consumes the `@openai/codex-sdk` `thread.runStreamed()` event stream and
// emits `NormalizedAgentEvent`s — the codex-side analog of `walkClaudeMessages`
// (Claude) and `decodeOpencodePart` (opencode). Per doctrine invariant #13,
// the resulting normalized stream is mapped to the same WalkthroughStreamEvent
// / ChatStreamFrame surfaces as the other two providers, so externally-
// observable behavior matches.
//
// Codex differs from the other two transports in a few ways the mapping
// handles:
//   • Items arrive as `item.started` / `item.updated` / `item.completed`,
//     each carrying the FULL current item (not a delta). We track the emitted
//     text length per item id and emit only the new tail, so text/reasoning
//     stream incrementally regardless of how codex batches updates.
//   • Tool work surfaces as discrete items: `command_execution` (shell),
//     `file_change` (patch), `mcp_tool_call` (the MCP tools that drive the
//     walkthrough/recap pipelines), `web_search`. Each is emitted once, on
//     completion, so its terminal status is known.
//   • The thread id used for resume is delivered up-front via the
//     `thread.started` event (the SDK's `thread.id` getter is null until then).

import type {
  AgentMessageItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ReasoningItem,
  ThreadEvent,
  ThreadItem,
  TodoListItem,
  Usage,
  WebSearchItem,
} from "@openai/codex-sdk";
import type { WalkthroughTokenUsage } from "@revv/shared";
import type { NormalizedAgentEvent, NormalizedTask } from "./normalized-events";

export interface WalkCodexEventsOptions {
  /**
   * Fired once with the thread id as soon as codex emits `thread.started`.
   * Callers use it to persist the resume id (chat `(prId, agent, headSha) →
   * sessionId`; walkthrough `codexThreadId`) before the stream closes.
   * Not fired on a resumed thread that re-uses an existing id — the SDK only
   * emits `thread.started` for a fresh thread.
   */
  readonly onThreadStarted?: (threadId: string) => void | Promise<void>;
}

/**
 * Walk a codex `ThreadEvent` stream and emit normalized events. Returns the
 * turn's `WalkthroughTokenUsage` parsed from the terminal `turn.completed`
 * event, or `undefined` if the stream ended without one.
 */
export async function walkCodexEvents(
  events: AsyncGenerator<ThreadEvent> | AsyncIterable<ThreadEvent>,
  emit: (ev: NormalizedAgentEvent) => void,
  opts?: WalkCodexEventsOptions,
): Promise<WalkthroughTokenUsage | undefined> {
  let tokenUsage: WalkthroughTokenUsage | undefined;

  // Per-item cumulative emitted length so updated/completed events only emit
  // the new tail. Codex carries the full text on every item event.
  const emittedTextLen = new Map<string, number>();
  const emittedReasoningLen = new Map<string, number>();
  // Tool-shaped items (command_execution / file_change / mcp_tool_call /
  // web_search) are emitted exactly once, keyed by item id.
  const emittedToolItems = new Set<string>();

  for await (const event of events) {
    switch (event.type) {
      case "thread.started":
        if (opts?.onThreadStarted) await opts.onThreadStarted(event.thread_id);
        break;
      case "item.started":
      case "item.updated":
      case "item.completed":
        handleItem(event.item, event.type === "item.completed");
        break;
      case "turn.completed":
        tokenUsage = mapCodexUsage(event.usage);
        break;
      case "turn.failed":
        emit({ kind: "error", message: event.error.message });
        break;
      case "error":
        emit({ kind: "error", message: event.message });
        break;
      // turn.started carries no payload we surface.
      default:
        break;
    }
  }

  return tokenUsage;

  function handleItem(item: ThreadItem, completed: boolean): void {
    switch (item.type) {
      case "agent_message": {
        emitTextTail(emittedTextLen, item.id, (item as AgentMessageItem).text, (chunk) =>
          emit({ kind: "text-delta", data: chunk, partId: item.id }),
        );
        return;
      }
      case "reasoning": {
        emitTextTail(emittedReasoningLen, item.id, (item as ReasoningItem).text, (chunk) =>
          emit({ kind: "reasoning-delta", data: chunk, partId: item.id }),
        );
        return;
      }
      case "command_execution": {
        // Shell commands: emit once on completion so the exit status is known.
        if (!completed || emittedToolItems.has(item.id)) return;
        emittedToolItems.add(item.id);
        const cmd = item as CommandExecutionItem;
        emit({
          kind: "tool-call",
          toolName: "Bash",
          input: { command: cmd.command },
          callId: item.id,
          source: "builtin",
          bareName: "Bash",
        });
        return;
      }
      case "file_change": {
        if (!completed || emittedToolItems.has(item.id)) return;
        emittedToolItems.add(item.id);
        const fc = item as FileChangeItem;
        const first = fc.changes[0];
        // Map to the canonical Edit/Write tool surface so `buildActivity`
        // renders a familiar pill. A pure "add" reads as Write; otherwise Edit.
        const allAdds = fc.changes.length > 0 && fc.changes.every((c) => c.kind === "add");
        emit({
          kind: "tool-call",
          toolName: allAdds ? "Write" : "Edit",
          input: { file_path: first?.path ?? "", changes: fc.changes },
          callId: item.id,
          source: "builtin",
          bareName: allAdds ? "Write" : "Edit",
        });
        return;
      }
      case "mcp_tool_call": {
        // The MCP tools that drive the walkthrough/recap pipelines. Emit once
        // on completion; the actual DB write already happened server-side in
        // the HTTP MCP route handler (commit-first, invariant #8). Consumers
        // match `bareName` against their TOOL_SPECS to drive phase transitions.
        if (!completed || emittedToolItems.has(item.id)) return;
        emittedToolItems.add(item.id);
        const mcp = item as McpToolCallItem;
        emit({
          kind: "tool-call",
          toolName: `mcp__${mcp.server}__${mcp.tool}`,
          input: mcp.arguments,
          callId: item.id,
          source: "mcp",
          mcpServer: mcp.server,
          bareName: mcp.tool,
        });
        return;
      }
      case "web_search": {
        if (!completed || emittedToolItems.has(item.id)) return;
        emittedToolItems.add(item.id);
        const ws = item as WebSearchItem;
        emit({
          kind: "tool-call",
          toolName: "WebSearch",
          input: { query: ws.query },
          callId: item.id,
          source: "builtin",
          bareName: "WebSearch",
        });
        return;
      }
      case "todo_list": {
        // Re-emit the full snapshot on every update; the consumer reconciles
        // against persisted rows (same contract as Claude/opencode).
        const todo = item as TodoListItem;
        emit({
          kind: "task-list-update",
          tasks: todo.items.map((t, idx) => codexTodoToTask(t, idx)),
          source: "codex",
        });
        return;
      }
      case "error": {
        emit({ kind: "error", message: item.message });
        return;
      }
      default:
        return;
    }
  }
}

/**
 * Emit only the portion of `full` not yet emitted for `id`. Codex carries the
 * complete text on each item event, so diffing against the last emitted length
 * turns repeated full-text updates into incremental deltas.
 */
function emitTextTail(
  lengths: Map<string, number>,
  id: string,
  full: string | undefined,
  sink: (chunk: string) => void,
): void {
  const text = full ?? "";
  const prev = lengths.get(id) ?? 0;
  if (text.length <= prev) return;
  sink(text.slice(prev));
  lengths.set(id, text.length);
}

function codexTodoToTask(item: TodoListItem["items"][number], index: number): NormalizedTask {
  return {
    id: `codex-todo-${index}`,
    content: item.text,
    activeForm: null,
    status: item.completed ? "completed" : "pending",
    priority: null,
  };
}

/**
 * Map codex's per-turn `Usage` to the cross-provider `WalkthroughTokenUsage`.
 * Reasoning output tokens are folded into `outputTokens` to match Claude's
 * shape (its `output_tokens` already includes reasoning). Codex does not
 * report cache-creation tokens, so that field is 0.
 */
export function mapCodexUsage(usage: Usage): WalkthroughTokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens + usage.reasoning_output_tokens,
    cacheReadInputTokens: usage.cached_input_tokens,
    cacheCreationInputTokens: 0,
    // Point-in-time context occupancy: the full prompt plus this turn's output.
    // Codex reports `cached_input_tokens` SEPARATELY from `input_tokens` (it is
    // not folded in — see the throughput fields above), so the cached portion
    // must be added back to reflect the true prompt size. Mirrors the
    // Claude/opencode occupancy formulas, which likewise count the whole prompt
    // including their cache terms; do not "simplify" by dropping it.
    contextTokens:
      usage.input_tokens +
      usage.cached_input_tokens +
      usage.output_tokens +
      usage.reasoning_output_tokens,
  };
}
