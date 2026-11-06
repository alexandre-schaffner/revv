import type { ActivityKind } from "@revv/shared";
import { TOOL_PATH_INPUT_KEYS } from "@revv/shared";
import { basename } from "$lib/utils/path";
import { plural } from "$lib/utils/plural";

export interface GroupableActivity {
  readonly id: string;
  readonly activityKind: ActivityKind;
  readonly toolName: string;
  readonly summary: string;
  readonly turnId?: string;
  /** Raw tool input (file_path, command, …) — drives the clickable peek. */
  readonly payload?: unknown;
  readonly callId?: string;
  /** Captured tool output (stdout / result text), once available. */
  readonly output?: string;
  readonly isError?: boolean;
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

/** "3 reads, 1 search": the count a group's header shows, as text. */
export function activityGroupSummary(
  items: readonly Pick<GroupableActivity, "activityKind" | "toolName">[],
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

/**
 * Reads, searches and lists in a group. A tool counts by its kind or, when an
 * agent reports a builtin under another kind, by its name.
 */
export function activityGroupCounts(
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

function activityToolLabel(item: Pick<GroupableActivity, "activityKind" | "toolName">): string {
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
 * The bold tool name shown in a card header; a Read with captured output
 * carries its line count ("Read 40 lines").
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
  return count > 0 ? plural(count, one, other) : null;
}

/** Tool kinds whose payload names a single file the peek can render. */
const FILE_TOOL_KINDS = new Set<ActivityKind>(["tool.read", "tool.write", "tool.edit"]);

function payloadString(payload: unknown, key: string): string {
  if (payload === null || typeof payload !== "object") return "";
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

function payloadNumber(payload: unknown, key: string): number | null {
  if (payload === null || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)[key];
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  // ACP/opencode delivers tool-call numeric args as strings, so coerce or the
  // Read window silently fails to engage for that agent path (breaking the
  // agent-path parity invariant).
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function payloadPath(payload: unknown): string {
  for (const key of TOOL_PATH_INPUT_KEYS) {
    const value = payloadString(payload, key);
    if (value) return value;
  }
  return "";
}

/**
 * The single file a Read/Write/Edit touched; repo-relative when the server
 * relativized it.
 */
export function activityFilePath(
  item: Pick<GroupableActivity, "activityKind" | "payload">,
): string | null {
  if (!FILE_TOOL_KINDS.has(item.activityKind)) return null;
  return payloadPath(item.payload) || null;
}

/**
 * The line window a Read requested, so the peek shows only what the agent
 * read. `offset` is 1-based (1 when only a limit is given); a null `limit`
 * runs to the end of the file. Null for non-reads and full-file reads.
 */
export function activityReadWindow(
  item: Pick<GroupableActivity, "activityKind" | "payload">,
): { offset: number; limit: number | null } | null {
  if (item.activityKind !== "tool.read") return null;
  const offset = payloadNumber(item.payload, "offset");
  const limit = payloadNumber(item.payload, "limit");
  if (offset === null && limit === null) return null;
  return {
    offset: offset !== null && offset > 0 ? offset : 1,
    limit: limit !== null && limit > 0 ? limit : null,
  };
}

export function activityCommand(
  item: Pick<GroupableActivity, "activityKind" | "payload">,
): string | null {
  if (item.activityKind !== "tool.bash") return null;
  return payloadString(item.payload, "command") || null;
}

/**
 * The dimmed text beside the tool name in a card header ("Read ·
 * PromptInputTextarea.svelte", "Bash · git status"); empty when the payload
 * carries no useful detail.
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
 * Whether the expanded body would show more than the header: a file, a
 * command and its output, or captured output. MCP/other tools stay peekable
 * with a payload, since their raw JSON input is their only view; a builtin
 * (Grep, LS) with no output renders as a static row.
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
