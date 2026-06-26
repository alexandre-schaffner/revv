import type { ActivityKind } from "@revv/shared";

export interface GroupableActivity {
  readonly id: string;
  readonly activityKind: ActivityKind;
  readonly toolName: string;
  readonly summary: string;
  readonly turnId?: string;
  /** Raw tool input (file_path, command, …) — drives the clickable peek. */
  readonly payload?: unknown;
  /** Provider tool-call id. */
  readonly callId?: string;
  /** Captured tool output (stdout / result text), once available. */
  readonly output?: string;
  /** Whether the tool call ended in error. */
  readonly isError?: boolean;
  readonly subagentInvocationId?: string;
}

export interface ActivityGroupCounts {
  readonly reads: number;
  readonly searches: number;
  readonly lists: number;
}

const EXPLORATION_KINDS = new Set<ActivityKind>(["tool.read", "tool.grep", "tool.glob", "tool.ls"]);

export function isExplorationActivity(activity: Pick<GroupableActivity, "activityKind">): boolean {
  return EXPLORATION_KINDS.has(activity.activityKind);
}

export function activityGroupSummary(
  items: readonly Pick<GroupableActivity, "activityKind">[],
): string {
  const { reads, searches, lists } = activityGroupCounts(items);

  return [
    countLabel(reads, "read", "reads"),
    countLabel(searches, "search", "searches"),
    countLabel(lists, "list", "lists"),
  ]
    .filter((label): label is string => !!label)
    .join(", ");
}

export function activityGroupCounts(
  items: readonly Pick<GroupableActivity, "activityKind">[],
): ActivityGroupCounts {
  return {
    reads: items.filter((item) => item.activityKind === "tool.read").length,
    searches: items.filter(
      (item) => item.activityKind === "tool.grep" || item.activityKind === "tool.glob",
    ).length,
    lists: items.filter((item) => item.activityKind === "tool.ls").length,
  };
}

export function robustActivityGroupCounts(
  items: readonly Pick<GroupableActivity, "activityKind" | "toolName">[],
): ActivityGroupCounts {
  let reads = 0;
  let searches = 0;
  let lists = 0;

  for (const item of items) {
    const label = activityToolLabel(item).toLowerCase();
    if (item.activityKind === "tool.read" || label === "read") reads++;
    else if (
      item.activityKind === "tool.grep" ||
      item.activityKind === "tool.glob" ||
      label === "grep" ||
      label === "glob"
    )
      searches++;
    else if (item.activityKind === "tool.ls" || label === "list") lists++;
  }

  return { reads, searches, lists };
}

export function activityToolLabel(
  item: Pick<GroupableActivity, "activityKind" | "toolName">,
): string {
  if (item.activityKind === "tool.read") return "Read";
  if (item.activityKind === "tool.grep") return "Grep";
  if (item.activityKind === "tool.glob") return "Glob";
  if (item.activityKind === "tool.ls") return "List";
  return item.toolName
    .replace(/^mcp__[^_]+__/, "")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * The bold tool name shown in a card header. Same as {@link activityToolLabel}
 * except a Read with captured output surfaces the line count ("Read 40 lines"),
 * mirroring the reference UI. Owning the read special-case here keeps
 * `ToolCallCard` a dumb renderer rather than re-parsing output inline.
 */
export function activityLabel(item: {
  readonly activityKind: ActivityKind;
  readonly toolName: string;
  readonly output?: string | undefined;
}): string {
  const base = activityToolLabel(item);
  if (item.activityKind !== "tool.read" || !item.output) return base;
  const lines = item.output.replace(/\n$/, "").split("\n").length;
  return lines > 0 ? `${base} ${lines} lines` : base;
}

function countLabel(count: number, one: string, other: string): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? one : other}`;
}

// ── Tool-call detail extraction (for the verbose, clickable card) ────────────

/** Tool kinds whose payload names a single file the peek can render. */
const FILE_TOOL_KINDS = new Set<ActivityKind>(["tool.read", "tool.write", "tool.edit"]);

function payloadString(payload: unknown, key: string): string {
  if (payload === null || typeof payload !== "object") return "";
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

/**
 * Path keys a file tool's input may carry, in precedence order. Mirrors the
 * server's `PATH_INPUT_KEYS` (normalized-events.ts) — Claude uses `file_path`,
 * opencode-style tools may use `path`, notebooks `notebook_path` — so the peek
 * resolves regardless of which the provider populated.
 */
const PATH_INPUT_KEYS = ["file_path", "path", "notebook_path"] as const;

function payloadPath(payload: unknown): string {
  for (const key of PATH_INPUT_KEYS) {
    const value = payloadString(payload, key);
    if (value) return value;
  }
  return "";
}

/** Last path segment, for compact headers (`…/PromptInputTextarea.svelte`). */
export function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * The single file path a Read/Write/Edit touched, if any — repo-relative when
 * the server relativized it. Used to fetch a content peek via
 * `GET /api/prs/:id/repo-file`. Null for non-file tools or when absent.
 */
export function activityFilePath(
  item: Pick<GroupableActivity, "activityKind" | "payload">,
): string | null {
  if (!FILE_TOOL_KINDS.has(item.activityKind)) return null;
  return payloadPath(item.payload) || null;
}

/** The shell command a Bash tool ran, if any. Drives the terminal peek. */
export function activityCommand(
  item: Pick<GroupableActivity, "activityKind" | "payload">,
): string | null {
  if (item.activityKind !== "tool.bash") return null;
  return payloadString(item.payload, "command") || null;
}

/**
 * The dimmed, secondary text shown next to the bold tool name in a card header
 * — the file name, command, or search pattern that makes the call legible at a
 * glance ("Read · PromptInputTextarea.svelte", "Bash · git status"). Empty when
 * the payload carries no useful detail.
 */
export function activityDetailText(
  item: Pick<GroupableActivity, "activityKind" | "payload" | "summary">,
): string {
  const file = activityFilePath(item);
  if (file) return basename(file);
  const command = activityCommand(item);
  if (command) return command.split("\n")[0]?.trim() ?? "";
  switch (item.activityKind) {
    case "tool.grep":
    case "tool.glob":
      return payloadString(item.payload, "pattern");
    case "tool.ls":
      return payloadString(item.payload, "path");
    case "tool.other":
      // Synthetic/status rows (e.g. the merge-and-push flow) carry their
      // message in `summary`; the title-cased tool name alone isn't enough.
      return item.summary;
    default:
      // MCP tools: the title-cased label already names the tool, and the
      // summary ("Using mcp__…") is noise. Leave the detail empty.
      return "";
  }
}

/**
 * Whether a tool call has something worth peeking at — i.e. an expanded body
 * that shows more than its header already does. That means a genuine view: a
 * file to render, a command + its terminal output, or captured output text.
 *
 * MCP/other tools are the one case where the only "view" is the raw JSON input
 * (`<ToolInput>`), so they stay peekable when they carry a payload. Plain
 * builtin tools (a Grep, an LS) with no captured output render as a cheap
 * static row instead of an expandable card whose body would just echo input.
 */
export function activityHasPeek(item: {
  readonly activityKind: ActivityKind;
  readonly payload?: unknown;
  readonly output?: string | undefined;
}): boolean {
  return (
    activityFilePath(item) !== null ||
    activityCommand(item) !== null ||
    (typeof item.output === "string" && item.output.length > 0) ||
    ((item.activityKind === "tool.mcp" || item.activityKind === "tool.other") &&
      item.payload !== undefined &&
      item.payload !== null)
  );
}
