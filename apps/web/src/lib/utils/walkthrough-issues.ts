import type { UserSettings, WalkthroughIssue } from "@revv/shared";

export type IssueSeverity = WalkthroughIssue["severity"];

/**
 * Canonical render order for severity buckets — most severe first so the
 * reviewer's eye lands on blockers before nice-to-knows. The walkthrough
 * stream emits issues in the order the model surfaces them; we re-bucket
 * for display but preserve original order *within* each bucket so the
 * step linkage (`→ Step N`) still reads in increasing step numbers.
 */
export const SEVERITY_ORDER: readonly IssueSeverity[] = ["critical", "warning", "info"] as const;

export const SEVERITY_LABELS: Record<IssueSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

export interface IssueGroup {
  severity: IssueSeverity;
  label: string;
  issues: WalkthroughIssue[];
}

/**
 * One entry per issue, but tagged with its global render index across every
 * group. Both the GuidedWalkthrough and RequestChanges panels use this to
 * keep the entrance animation staggered as one continuous cascade rather
 * than restarting per-group.
 */
export interface GroupedIssue {
  issue: WalkthroughIssue;
  globalIndex: number;
}

export interface IssueGroupView extends Omit<IssueGroup, "issues"> {
  issues: GroupedIssue[];
}

/**
 * Bucket issues by severity (Critical → Warning → Info). Empty buckets are
 * dropped. Within each bucket original arrival order is preserved.
 */
export function groupIssuesBySeverity(issues: readonly WalkthroughIssue[]): IssueGroup[] {
  const buckets: Record<IssueSeverity, WalkthroughIssue[]> = {
    critical: [],
    warning: [],
    info: [],
  };
  for (const issue of issues) {
    const bucket = buckets[issue.severity];
    if (bucket) bucket.push(issue);
  }
  const groups: IssueGroup[] = [];
  for (const severity of SEVERITY_ORDER) {
    const bucketIssues = buckets[severity];
    if (bucketIssues.length === 0) continue;
    groups.push({ severity, label: SEVERITY_LABELS[severity], issues: bucketIssues });
  }
  return groups;
}

/**
 * Same grouping as `groupIssuesBySeverity`, but each issue carries its
 * `globalIndex` so callers can compute cascade-style animation delays
 * without manually threading a counter through nested `{#each}` blocks.
 */
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

export interface SignalPartition {
  /** Issues to render. Everything unscored lands here. */
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
