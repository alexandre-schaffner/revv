/**
 * Persisted into `chat_activities.activity_kind`, so stored rows carry these
 * strings; add new entries here AND on the schema column's comment.
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
 * - `toolName` is the raw provider tool name (`Read`, `Bash`,
 *   `mcp__revv-chat-context__get_review_context`).
 * - `summary` is the human-readable one-liner ("Read foo.ts", "Bash: git status").
 * - `payload` is the raw tool input, when the agent reports one.
 */
export interface Activity {
  readonly activityKind: ActivityKind;
  readonly toolName: string;
  readonly summary: string;
  readonly payload?: unknown;
  /**
   * ACP `toolCallId`; a later `tool_call_update` result is correlated back
   * onto this activity by it. Absent on phase/MCP-emitted activities.
   */
  readonly callId?: string;
}

/**
 * Terminal result of a tool call, from the ACP `tool_call_update` whose
 * `status` reaches `completed`/`failed`. `output` is best-effort text and may
 * be truncated by the producer.
 */
export interface ActivityResult {
  readonly callId: string;
  readonly output: string;
  readonly isError: boolean;
}

/**
 * Tool-input keys that hold a file path, in precedence order: Claude uses
 * `file_path`, opencode-style tools `path`, notebook tools `notebook_path`.
 */
export const TOOL_PATH_INPUT_KEYS = ["file_path", "path", "notebook_path"] as const;

/**
 * A tool `output` string holds either plain text OR a JSON-encoded
 * {@link ToolDiffOutput} tagged with this key. Both ends must go through
 * {@link encodeToolDiffOutput} / {@link decodeToolDiffOutput}.
 */
export const DIFF_OUTPUT_SENTINEL = "__revvDiff" as const;

export interface ToolDiffOutput {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

export function encodeToolDiffOutput(path: string, oldText: string, newText: string): string {
  return JSON.stringify({ [DIFF_OUTPUT_SENTINEL]: true, path, oldText, newText });
}

export function decodeToolDiffOutput(output: string | undefined): ToolDiffOutput | null {
  if (output?.[0] !== "{") return null;
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
