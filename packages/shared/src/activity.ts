// ── Activity ────────────────────────────────────────────────────────────────
//
// Canonical shape for "the agent did a thing" events. Used wherever a
// provider's tool-use needs to be surfaced to the orchestrator or UI:
//
//   - chat (right-pane multi-turn): persisted into `chat_activities` and
//     forwarded via the `activity` SSE-frame discriminator.
//   - walkthrough generation (transient): broadcast over SSE as the
//     `exploration` variant of `WalkthroughStreamEvent`. Drives the rolling
//     6-step status window in the guided walkthrough header.
//
// Owning the type here (instead of in apps/server) means the web frontend
// can import it directly, without the parallel-mirror duplication that lived
// in apps/web/src/lib/api/chat.ts before unification.

/**
 * Controlled vocabulary for activity classification. Persisted into
 * `chat_activities.activity_kind`. New entries should be added here AND
 * documented on the schema column.
 */
export type ActivityKind =
  | "tool.read"
  | "tool.grep"
  | "tool.glob"
  | "tool.ls"
  | "tool.bash"
  | "tool.write"
  | "tool.edit"
  | "tool.todo"
  | "tool.mcp"
  | "tool.other";

/**
 * Structured tool-use record. Replaces the legacy `{tool, description}` pair
 * the walkthrough emitter and the chat SSE frame both used independently.
 *
 * - `activityKind` is the typed bucket the UI picks an icon/style off.
 * - `toolName` is the raw provider tool name (`Read`, `Bash`,
 *   `mcp__revv-chat-context__get_review_context`). Useful for debugging
 *   parity across provider drivers.
 * - `summary` is the human-readable one-liner ("Read foo.ts", "Bash: git status").
 *   Built by `buildExplorationDescription` (in apps/server) so both surfaces
 *   format identically.
 * - `payload` is the raw tool input when the provider exposes it (Claude SDK
 *   does, opencode does not yet). Optional; carries Activity into future
 *   approval flows without a schema change.
 */
export interface Activity {
  readonly activityKind: ActivityKind;
  readonly toolName: string;
  readonly summary: string;
  readonly payload?: unknown;
  /**
   * When set, this activity row was emitted by a sub-agent (Claude `Task`
   * tool, opencode `agent` part) rather than the parent agent. The UI uses
   * this to nest the activity inside the matching `ChatSubagentInvocation`
   * card. Unset for top-level tool calls.
   */
  readonly subagentInvocationId?: string;
}

/**
 * Map a raw provider tool name to a canonical `ActivityKind`. The input is
 * expected to already be the Anthropic-canonical name (`Read`, `Grep`, ...).
 * Opencode's lowercase names should pass through `normalizeToolName` first.
 *
 * Both walkthrough providers and both chat providers run this against the
 * same input, so identical tool calls produce identical kinds across the
 * Claude / opencode split (doctrine invariant #13: agent-path parity).
 */
export function classifyTool(toolName: string): ActivityKind {
  switch (toolName) {
    case "Read":
      return "tool.read";
    case "Grep":
      return "tool.grep";
    case "Glob":
      return "tool.glob";
    case "LS":
      return "tool.ls";
    case "Bash":
      return "tool.bash";
    case "Write":
      return "tool.write";
    case "Edit":
      return "tool.edit";
    case "TodoRead":
    case "TodoWrite":
      return "tool.todo";
    default:
      if (toolName.startsWith("mcp__")) return "tool.mcp";
      return "tool.other";
  }
}

/**
 * Opencode's daemon emits built-in tool names in lowercase (`read`, `grep`,
 * `bash`, …) on /event, while the rest of Revv uses Anthropic's canonical
 * capitalized form (`Read`, `Grep`, …). The map below normalizes opencode's
 * shape into the canonical names so `classifyTool(...)` and the various
 * `EXPLORATION_TOOLS` sets keep working.
 */
const OPENCODE_TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  grep: "Grep",
  glob: "Glob",
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  list: "LS",
  todoread: "TodoRead",
  todowrite: "TodoWrite",
};

/**
 * Canonicalise a provider-emitted tool name. Idempotent — already-canonical
 * names (Claude SDK shape) pass through unchanged. Lowercase opencode names
 * are mapped via the table above.
 */
export function normalizeToolName(raw: string): string {
  return OPENCODE_TOOL_NAME_MAP[raw.toLowerCase()] ?? raw;
}
