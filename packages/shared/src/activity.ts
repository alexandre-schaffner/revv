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
   * Provider-assigned tool-call id (ACP `toolCallId`). Carried so a later
   * tool *result* (decoded from the ACP `tool_call_update` and surfaced as an
   * `activity-result` chat frame / `exploration-result` walkthrough event) can
   * be correlated back onto this activity for the clickable output peek.
   * Optional — phase/MCP-emitted activities have no call id.
   */
  readonly callId?: string;
  /**
   * When set, this activity row was emitted by a sub-agent (Claude `Task`
   * tool, opencode `agent` part) rather than the parent agent. The UI uses
   * this to nest the activity inside the matching `ChatSubagentInvocation`
   * card. Unset for top-level tool calls.
   */
  readonly subagentInvocationId?: string;
}

/**
 * Captured terminal result of a tool call — the output/stdout (or error text)
 * a tool produced, decoded from the ACP `tool_call_update` notification once
 * its `status` reaches a terminal `completed`/`failed`. Correlated to its
 * originating {@link Activity} by `callId`. `output` is best-effort textual
 * content (text content blocks joined; diffs rendered to text) and may be
 * truncated by the producer to keep the journal small.
 */
export interface ActivityResult {
  readonly callId: string;
  readonly output: string;
  readonly isError: boolean;
}

/**
 * Sentinel-tagged structured diff carried in an {@link ActivityResult}'s/
 * activity's `output` string for file-edit tool calls. Plain string output
 * (Bash stdout, file reads) never carries the sentinel.
 *
 * The tool `output` column is a single multiplexed channel: it holds either
 * plain text OR a JSON-encoded {@link ToolDiffOutput}. The sentinel key is the
 * discriminator. Both ends MUST go through {@link encodeToolDiffOutput} /
 * {@link decodeToolDiffOutput} so the wire shape lives in exactly one place —
 * the server decoder encodes it, the web ToolCallCard decodes it to render a
 * real diff + LOC counts.
 */
export const DIFF_OUTPUT_SENTINEL = "__revvDiff" as const;

/** Old/new pair for a file edit, recovered from a tool's diff/output. */
export interface ToolDiffOutput {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

/** Encode an edit's before/after into the sentinel-tagged `output` channel. */
export function encodeToolDiffOutput(path: string, oldText: string, newText: string): string {
  return JSON.stringify({ [DIFF_OUTPUT_SENTINEL]: true, path, oldText, newText });
}

/**
 * Decode an activity `output` as a structured edit diff, or null when it is
 * plain text (or absent). The leading-`{` check is a cheap fast-path so the
 * common plain-text case never hits `JSON.parse`.
 */
export function decodeToolDiffOutput(output: string | undefined): ToolDiffOutput | null {
  if (!output || output[0] !== "{") return null;
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (parsed[DIFF_OUTPUT_SENTINEL] !== true) return null;
    return {
      path: typeof parsed.path === "string" ? parsed.path : "",
      oldText: typeof parsed.oldText === "string" ? parsed.oldText : "",
      newText: typeof parsed.newText === "string" ? parsed.newText : "",
    };
  } catch {
    return null;
  }
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
