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
   * Terminal result of a previously-emitted `tool-call`, decoded from the ACP
   * `tool_call_update` notification once its `status` reaches `completed` /
   * `failed`. `callId` correlates back to the originating `tool-call`. `output`
   * is best-effort textual content (text content blocks joined; diffs rendered
   * to text); producers truncate it to keep the journal small. Surfaced to the
   * UI as a clickable output peek (chat `activity-result` /
   * walkthrough `exploration-result`).
   */
  | {
      readonly kind: "tool-result";
      readonly callId: string;
      readonly output: string;
      readonly isError: boolean;
    }
  /**
   * Late-arriving tool input for a previously-emitted `tool-call`, decoded from
   * the first `tool_call_update` that carries a usable `rawInput`/`locations`.
   * Some adapters send the initial `tool_call` with an empty input and only fill
   * it in on a follow-up update; this lets the UI back-fill the activity's
   * filename/command (and file peek) by `callId`.
   */
  | {
      readonly kind: "tool-call-update";
      readonly callId: string;
      readonly input: unknown;
    }
  /**
   * Full task-list snapshot. Both providers re-emit the entire list on each
   * update — the consumer reconciles against persisted rows.
   */
  | {
      readonly kind: "task-list-update";
      readonly tasks: ReadonlyArray<NormalizedTask>;
      readonly source: "acp";
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
      readonly source: "acp";
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
      readonly source: "acp";
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
      readonly source: "acp";
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
      readonly source: "acp";
      readonly questions: ReadonlyArray<import("@revv/shared").NormalizedQuestion>;
      readonly previewFormat: "markdown" | "html";
      /** Opencode `QuestionRequest.tool.callID`; absent for Claude. */
      readonly providerToolCallId?: string;
    }
  /**
   * Out-of-band resolution follow-up: emitted when the agent surfaces a
   * question-resolved signal after our reply was POSTed back to it. We emit
   * this so the persistence wrapper can flip the row's status idempotently
   * (the answer endpoint already wrote the DB row on the user-facing path).
   *
   * Agents whose resolution lives entirely inside the answer endpoint
   * (resolve the in-memory deferred and update DB inline) never emit this.
   */
  | {
      readonly kind: "user-question-resolved";
      readonly providerRequestId: string;
      readonly source: "acp";
      readonly status: "answered" | "rejected";
      readonly answers?: Readonly<Record<string, ReadonlyArray<string>>>;
    }
  /**
   * Point-in-time context-window occupancy from the agent. ACP's
   * `usage_update` carries only `used` (tokens currently in context) and
   * `size` (window size) — NOT the input/output/cache throughput breakdown —
   * so this event populates the occupancy gauge only. Consumers that track
   * `WalkthroughTokenUsage` fold it via `mergeContextOccupancy`; chat ignores
   * it. Not all ACP agents emit it; consumers must not depend on one arriving.
   */
  | {
      readonly kind: "usage";
      readonly contextTokens: number;
      readonly contextWindowTokens?: number;
    }
  | { readonly kind: "error"; readonly message: string };

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
import { buildExplorationDescription, toRepoRelative } from "../prompts/walkthrough";

export interface BuiltActivity {
  readonly activityKind: ActivityKind;
  readonly toolName: string;
  readonly summary: string;
  readonly payload?: unknown;
  readonly callId?: string;
}

/**
 * Tool-input keys that hold a filesystem path. When `cwd` is known we rewrite
 * these to repo-relative form so the persisted payload matches the (already
 * relativized) summary — and so the web file-peek can pass the path straight to
 * `GET /api/prs/:id/repo-file` (which resolves against the clone root, not an
 * absolute worktree path).
 */
const PATH_INPUT_KEYS = ["file_path", "path", "notebook_path"] as const;

export function relativizeToolInput(input: unknown, cwd?: string): unknown {
  if (!cwd || input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const obj = input as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  for (const key of PATH_INPUT_KEYS) {
    const v = obj[key];
    if (typeof v !== "string") continue;
    const rel = toRepoRelative(v, cwd);
    if (rel === v) continue;
    next ??= { ...obj };
    next[key] = rel;
  }
  return next ?? input;
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
 *
 * `cwd` (the agent's working directory — the per-job git worktree) is optional:
 * when supplied, absolute path arguments are rendered relative to it so the
 * feed shows `apps/server/…` instead of the full `/Users/…/worktree/…` path.
 */
export function buildActivity(
  rawToolName: string,
  input: unknown,
  cwd?: string,
  callId?: string,
): BuiltActivity {
  const toolName = normalizeToolName(rawToolName);
  return {
    activityKind: classifyTool(toolName),
    toolName,
    summary: buildExplorationDescription(toolName, input, cwd),
    ...(input !== undefined ? { payload: relativizeToolInput(input, cwd) } : {}),
    ...(callId !== undefined ? { callId } : {}),
  };
}
