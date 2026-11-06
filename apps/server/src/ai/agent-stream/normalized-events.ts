// ── Normalized event ────────────────────────────────────────────────────────

/**
 * Discriminated union of everything an ACP agent emits during a turn, decoded
 * from `session/update` by `decodeAcpSessionUpdate`. Callers switch on `kind`
 * to map into their own output frame (ChatStreamFrame or WalkthroughStreamEvent).
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
   * Full task-list snapshot (ACP `plan`). The agent re-emits the entire list on
   * each update — the consumer reconciles against persisted rows.
   */
  | {
      readonly kind: "task-list-update";
      readonly tasks: ReadonlyArray<NormalizedTask>;
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
