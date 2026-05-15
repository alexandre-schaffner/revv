// ── Normalized event ────────────────────────────────────────────────────────

/**
 * Discriminated union of everything a model can emit during a turn. Providers
 * decode their input shape into this union and callers switch on `kind` to
 * map into their own output frame (ChatStreamFrame or WalkthroughStreamEvent).
 *
 * `partId` on text/reasoning deltas is the upstream identifier (opencode's
 * Part `id`; absent for Claude SDK content blocks since those don't carry one).
 * Consumers don't usually need it — it's plumbed for future use (e.g. inline
 * thinking blocks that need to be grouped).
 *
 * `tool-call` carries `source` and `bareName` so callers stop re-parsing the
 * `mcp__<server>__<tool>` prefix shape in four different places. Built-in
 * tools (Read, Grep, Bash, …) get `source: 'builtin'`. MCP tools get
 * `source: 'mcp'`, with `mcpServer` set to the server name and `bareName`
 * set to the tool name with the prefix stripped. For opencode's bare MCP
 * tool names (no prefix), `source` stays `'builtin'` and `bareName === toolName` —
 * callers that need to match against MCP tool names (walkthrough phase
 * transitions) should compare `bareName` against the known set.
 */
/**
 * Snapshot entry inside a `task-list-update`. Mirrors the shared `ChatTask`
 * shape without the persistence id (the server assigns one downstream).
 */
export interface NormalizedTask {
  readonly id: string;
  readonly content: string;
  readonly activeForm: string | null;
  readonly status: "pending" | "in_progress" | "completed";
  readonly priority: "low" | "medium" | "high" | null;
}

export type NormalizedAgentEvent =
  | {
      readonly kind: "text-delta";
      readonly data: string;
      readonly partId?: string;
    }
  | {
      readonly kind: "reasoning-delta";
      readonly data: string;
      readonly partId?: string;
    }
  | {
      readonly kind: "tool-call";
      /** Canonical (Claude-style capitalized for built-ins; raw for MCP). */
      readonly toolName: string;
      readonly input: unknown;
      readonly callId?: string;
      readonly source: "builtin" | "mcp";
      /** Populated when `source === 'mcp'`. */
      readonly mcpServer?: string;
      /** `toolName` with the `mcp__<server>__` prefix stripped. */
      readonly bareName: string;
      /**
       * When the tool was emitted from inside a sub-agent (Claude
       * `parent_tool_use_id` matches a known Task invocation id, or
       * opencode part's `messageID` matches a sub-agent message), this
       * is the sub-agent's `providerCallId`. Callers can stamp it onto
       * the activity row so the UI groups it under the parent
       * SubagentInvocation card.
       */
      readonly subagentProviderCallId?: string;
    }
  /**
   * Full task-list snapshot. Both providers re-emit the entire list on each
   * update — the consumer reconciles against persisted rows.
   */
  | {
      readonly kind: "task-list-update";
      readonly tasks: ReadonlyArray<NormalizedTask>;
      readonly source: "claude" | "opencode";
    }
  /**
   * Agent has presented a plan (Claude ExitPlanMode tool, or the opencode
   * `plan` agent finishing its turn). `providerPlanId` is the source's id
   * for the plan emission (Claude tool_use.id; opencode synthesizes a UUID
   * per turn). The chat route persists the plan and forwards a wire-level
   * `plan-presented` frame with the assigned `planId`.
   */
  | {
      readonly kind: "plan-presented";
      readonly markdown: string;
      readonly providerPlanId: string;
      readonly source: "claude" | "opencode";
    }
  /**
   * A sub-agent invocation has started. The driver maintains a closure-side
   * map keyed by `providerCallId` so the matching `subagent-end` can be
   * correlated.
   */
  | {
      readonly kind: "subagent-start";
      readonly providerCallId: string;
      readonly subagentType: string;
      readonly description: string;
      readonly prompt: string;
      readonly source: "claude" | "opencode";
    }
  /**
   * A sub-agent invocation has finished. `ok = false` means the sub-agent
   * errored out (tool_result `is_error=true` for Claude; agent part state
   * marking error for opencode). `result` is the final summary text.
   */
  | {
      readonly kind: "subagent-end";
      readonly providerCallId: string;
      readonly result: string;
      readonly ok: boolean;
      readonly source: "claude" | "opencode";
    }
  /**
   * Agent has asked the user one or more questions and is paused waiting
   * for answers. Sources:
   *   - Claude: `tool_use { name: "askUserQuestion" }` intercepted by
   *     `canUseTool`. `providerRequestId = tool_use.id`. The driver holds
   *     a Promise resolved when the answer endpoint fires.
   *   - Opencode: `question.asked` event from `/global/event`.
   *     `providerRequestId = QuestionRequest.id`. The opencode daemon
   *     stays paused until `/question/{id}/reply` is hit out-of-band.
   *
   * The route's persistence wrapper assigns a server-side `questionId`,
   * writes the row, and forwards a `user-question` wire frame.
   */
  | {
      readonly kind: "user-question-asked";
      readonly providerRequestId: string;
      readonly source: "claude" | "opencode";
      readonly questions: ReadonlyArray<import("@revv/shared").NormalizedQuestion>;
      readonly previewFormat: "markdown" | "html";
      /** Opencode `QuestionRequest.tool.callID`; absent for Claude. */
      readonly providerToolCallId?: string;
    }
  /**
   * Opencode-only follow-up: the daemon broadcasts `question.replied` /
   * `question.rejected` after our HTTP POST resolves the question. We emit
   * this so the persistence wrapper can flip the row's status idempotently
   * (the answer endpoint already wrote the DB row on the user-facing path).
   *
   * Claude doesn't emit this — its resolution lives entirely inside the
   * answer endpoint (resolve the in-memory deferred and update DB inline).
   */
  | {
      readonly kind: "user-question-resolved";
      readonly providerRequestId: string;
      readonly source: "opencode";
      readonly status: "answered" | "rejected";
      readonly answers?: Readonly<Record<string, ReadonlyArray<string>>>;
    }
  | { readonly kind: "error"; readonly message: string };

/**
 * Helper used by both Claude and opencode adapters to derive `source` /
 * `mcpServer` / `bareName` from a raw tool name. Public so callers writing
 * their own tool-name dispatchers can stay consistent.
 */
export function classifyToolCallShape(rawToolName: string): {
  source: "builtin" | "mcp";
  mcpServer?: string;
  bareName: string;
} {
  if (rawToolName.startsWith("mcp__")) {
    const rest = rawToolName.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep > 0) {
      return {
        source: "mcp",
        mcpServer: rest.slice(0, sep),
        bareName: rest.slice(sep + 2),
      };
    }
  }
  return { source: "builtin", bareName: rawToolName };
}

export function normalizeTaskStatus(v: unknown): "pending" | "in_progress" | "completed" {
  if (v === "in_progress") return "in_progress";
  if (v === "completed") return "completed";
  // Opencode emits 'cancelled' too — we collapse to 'completed' for UI
  // simplicity (a cancelled task is closed). Anything else → pending.
  if (v === "cancelled") return "completed";
  return "pending";
}

export function normalizeTaskPriority(v: unknown): "low" | "medium" | "high" | null {
  if (v === "low" || v === "medium" || v === "high") return v;
  return null;
}

// ── Activity builder ────────────────────────────────────────────────────────

import type { ActivityKind } from "@revv/shared";
import { classifyTool, normalizeToolName } from "@revv/shared";
import { buildExplorationDescription } from "../prompts/walkthrough";

export interface BuiltActivity {
  readonly activityKind: ActivityKind;
  readonly toolName: string;
  readonly summary: string;
  readonly payload?: unknown;
}

/**
 * Build a renderable Activity from a raw tool name + input. Composes
 * `normalizeToolName` (opencode lowercase → canonical), `classifyTool`
 * (canonical → ActivityKind), and `buildExplorationDescription` (canonical +
 * input → user-friendly summary).
 *
 * Used by every provider that surfaces tool calls in the UI. Centralising
 * this means a future change to how we describe Bash commands or MCP tools
 * only needs to land in one place.
 */
export function buildActivity(rawToolName: string, input: unknown): BuiltActivity {
  const toolName = normalizeToolName(rawToolName);
  return {
    activityKind: classifyTool(toolName),
    toolName,
    summary: buildExplorationDescription(toolName, input),
    ...(input !== undefined ? { payload: input } : {}),
  };
}
