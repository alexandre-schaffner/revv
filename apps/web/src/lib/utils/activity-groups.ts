import type { ActivityKind } from "@revv/shared";

export interface GroupableActivity {
  readonly id: string;
  readonly activityKind: ActivityKind;
  readonly toolName: string;
  readonly summary: string;
  readonly turnId?: string;
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

function countLabel(count: number, one: string, other: string): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? one : other}`;
}
