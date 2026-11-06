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

/** What an ACP agent emits during a turn, decoded from `session/update`. */
export type NormalizedAgentEvent =
  | { readonly kind: "text-delta"; readonly data: string }
  | { readonly kind: "reasoning-delta"; readonly data: string }
  | {
      readonly kind: "tool-call";
      /**
       * Canonical name for built-ins ACP tags with a `kind` (Read, Grep, …);
       * the agent's human title for everything else, MCP tools included.
       */
      readonly toolName: string;
      readonly input: unknown;
      readonly callId?: string;
    }
  /**
   * Decoded from the ACP `tool_call_update` notification once its `status`
   * reaches `completed` / `failed`. `output` is best-effort text (diffs
   * rendered to text); producers truncate it to keep the journal small.
   */
  | {
      readonly kind: "tool-result";
      readonly callId: string;
      readonly output: string;
      readonly isError: boolean;
    }
  /**
   * Some adapters send the initial `tool_call` with an empty input and only
   * fill it in on a follow-up `tool_call_update`; this lets the UI back-fill
   * the activity by `callId`.
   */
  | {
      readonly kind: "tool-call-update";
      readonly callId: string;
      readonly input: unknown;
    }
  /**
   * Full task-list snapshot (ACP `plan`). The agent re-emits the entire list on
   * each update — the consumer reconciles against persisted rows.
   */
  | {
      readonly kind: "task-list-update";
      readonly tasks: ReadonlyArray<NormalizedTask>;
    }
  /**
   * ACP's `usage_update` carries only `used` (tokens currently in context) and
   * `size` (window size) — not the input/output/cache throughput breakdown —
   * so this feeds the occupancy gauge only. Not all ACP agents emit it;
   * consumers must not depend on one arriving.
   */
  | {
      readonly kind: "usage";
      readonly contextTokens: number;
      readonly contextWindowTokens?: number;
    };

export function normalizeTaskStatus(v: unknown): "pending" | "in_progress" | "completed" {
  if (v === "in_progress") return "in_progress";
  if (v === "completed") return "completed";
  // Off the ACP spec, but opencode's own task status; a cancelled task is closed.
  if (v === "cancelled") return "completed";
  return "pending";
}

export function normalizeTaskPriority(v: unknown): "low" | "medium" | "high" | null {
  if (v === "low" || v === "medium" || v === "high") return v;
  return null;
}
