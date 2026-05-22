import type { ActivityKind } from "@revv/shared";

export interface GroupableActivity {
  readonly id: string;
  readonly activityKind: ActivityKind;
  readonly toolName: string;
  readonly summary: string;
  readonly turnId?: string;
  readonly subagentInvocationId?: string;
}

export type ActivityGroupCategory = "exploring";

export interface ActivityGroup<T extends GroupableActivity = GroupableActivity> {
  readonly category: ActivityGroupCategory;
  readonly items: readonly T[];
}

export function isActivityGroup<T extends GroupableActivity>(value: ActivityGroup<T> | T): value is ActivityGroup<T> {
  return "category" in value && value.category === "exploring" && Array.isArray(value.items);
}

export interface ActivityGroupRange<T extends GroupableActivity = GroupableActivity> {
  readonly start: number;
  readonly end: number;
  readonly group: ActivityGroup<T>;
}

export interface ActivityGroupCounts {
  readonly reads: number;
  readonly searches: number;
  readonly lists: number;
}

const EXPLORATION_KINDS = new Set<ActivityKind>([
  "tool.read",
  "tool.grep",
  "tool.glob",
  "tool.ls",
]);

export function isExplorationActivity(activity: Pick<GroupableActivity, "activityKind">): boolean {
  return EXPLORATION_KINDS.has(activity.activityKind);
}

export function activityGroupSummary(items: readonly Pick<GroupableActivity, "activityKind">[]): string {
  const { reads, searches, lists } = activityGroupCounts(items);

  return [
    countLabel(reads, "read", "reads"),
    countLabel(searches, "search", "searches"),
    countLabel(lists, "list", "lists"),
  ]
    .filter((label): label is string => !!label)
    .join(", ");
}

export function activityGroupCounts(items: readonly Pick<GroupableActivity, "activityKind">[]): ActivityGroupCounts {
  return {
    reads: items.filter((item) => item.activityKind === "tool.read").length,
    searches: items.filter((item) => item.activityKind === "tool.grep" || item.activityKind === "tool.glob").length,
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
    else if (item.activityKind === "tool.grep" || item.activityKind === "tool.glob" || label === "grep" || label === "glob") searches++;
    else if (item.activityKind === "tool.ls" || label === "list") lists++;
  }

  return { reads, searches, lists };
}

export function activityToolLabel(item: Pick<GroupableActivity, "activityKind" | "toolName">): string {
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

export function groupActivityRuns<T extends GroupableActivity>(items: readonly T[]): Array<ActivityGroup<T> | T> {
  const result: Array<ActivityGroup<T> | T> = [];
  let current: T[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    result.push({ category: "exploring", items: current });
    current = [];
  };

  for (const item of items) {
    if (isExplorationActivity(item)) {
      current.push(item);
      continue;
    }
    flush();
    result.push(item);
  }

  flush();
  return result;
}

export function activityGroupRanges<T extends GroupableActivity>(
  items: readonly T[],
): ActivityGroupRange<T>[] {
  const ranges: ActivityGroupRange<T>[] = [];
  let start = -1;
  let current: T[] = [];

  const flush = (end: number): void => {
    if (start < 0 || current.length === 0) return;
    ranges.push({
      start,
      end,
      group: { category: "exploring", items: current },
    });
    start = -1;
    current = [];
  };

  items.forEach((item, index) => {
    if (isExplorationActivity(item)) {
      if (start < 0) start = index;
      current.push(item);
      return;
    }

    flush(index);
  });

  flush(items.length);
  return ranges;
}
