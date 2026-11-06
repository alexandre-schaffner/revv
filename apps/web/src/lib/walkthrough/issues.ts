import {
  ISSUE_SEVERITIES,
  ISSUE_SEVERITY_LABEL,
  type IssueSeverity,
  type UserSettings,
  type WalkthroughIssue,
} from "@revv/shared";

export interface IssueGroup {
  severity: IssueSeverity;
  label: string;
  issues: WalkthroughIssue[];
}

/** `globalIndex` counts across every group, so a staggered entrance runs as one cascade. */
export interface GroupedIssue {
  issue: WalkthroughIssue;
  globalIndex: number;
}

export interface IssueGroupView extends Omit<IssueGroup, "issues"> {
  issues: GroupedIssue[];
}

function groupIssuesBySeverity(issues: readonly WalkthroughIssue[]): IssueGroup[] {
  const groups: IssueGroup[] = [];
  for (const severity of ISSUE_SEVERITIES) {
    const bucket = issues.filter((issue) => issue.severity === severity);
    if (bucket.length > 0)
      groups.push({ severity, label: ISSUE_SEVERITY_LABEL[severity], issues: bucket });
  }
  return groups;
}

export function groupIssuesBySeverityWithIndex(
  issues: readonly WalkthroughIssue[],
): IssueGroupView[] {
  const groups = groupIssuesBySeverity(issues);
  let globalIndex = 0;
  return groups.map((group) => ({
    severity: group.severity,
    label: group.label,
    issues: group.issues.map((issue) => ({ issue, globalIndex: globalIndex++ })),
  }));
}

/** Issues in group order: most severe first, arrival order within a severity. */
export function sortBySeverity(issues: readonly WalkthroughIssue[]): WalkthroughIssue[] {
  return groupIssuesBySeverity(issues).flatMap((group) => group.issues);
}

export interface SignalPartition {
  shown: WalkthroughIssue[];
  /** Issues collapsed behind the "show N filtered" disclosure. */
  filtered: WalkthroughIssue[];
}

/**
 * Split issues into what to show and what to tuck away. `lowSignal` is
 * computed server-side so every surface agrees without re-deriving a
 * threshold. An unscored issue (pre-feature walkthrough, cache-imported,
 * scoring pass off) is never low signal. A submitted issue is never hidden —
 * it's already on GitHub.
 */
export function partitionBySignal(
  issues: readonly WalkthroughIssue[],
  opts: { hideLowSignal: boolean },
): SignalPartition {
  if (!opts.hideLowSignal) return { shown: [...issues], filtered: [] };
  const shown: WalkthroughIssue[] = [];
  const filtered: WalkthroughIssue[] = [];
  for (const issue of issues) {
    if (issue.lowSignal === true && issue.submittedAt === undefined) filtered.push(issue);
    else shown.push(issue);
  }
  return { shown, filtered };
}

/** Low-signal issues collapse only while TypeSafe is on, so turning it off restores the full list. */
export function shouldHideLowSignal(settings: UserSettings | null | undefined): boolean {
  return settings?.jev.enabled ?? false;
}

export function countBySeverity(
  issues: readonly WalkthroughIssue[],
): Record<IssueSeverity, number> {
  const counts: Record<IssueSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity]++;
  return counts;
}

/** "2 walkthrough issues and 1 unresolved comment": what still stands in the way of an approve. */
export function outstandingItemsPhrase(issueCount: number, threadCount: number): string {
  const parts: string[] = [];
  if (issueCount > 0) parts.push(`${issueCount} walkthrough issue${issueCount === 1 ? "" : "s"}`);
  if (threadCount > 0) {
    parts.push(`${threadCount} unresolved comment${threadCount === 1 ? "" : "s"}`);
  }
  return parts.join(" and ");
}
