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
 * Split issues into what to show and what to tuck away.
 *
 * `lowSignal` is computed server-side (from the stored composite score) so
 * every surface — the walkthrough body, the Request Changes panel, the
 * per-file strip, the approve dialog, the address-issues prompt — agrees on
 * the same set without each re-deriving a threshold.
 *
 * **An unscored issue is never low signal.** That covers every walkthrough
 * generated before the feature, every cache-imported one (the importer
 * regenerates issue ids, so the scores don't travel), and every run where
 * the scoring pass was off or unreachable. Those all degrade to showing
 * everything, which is the pre-feature behaviour.
 *
 * A submitted issue is also never hidden: it is already on GitHub, and
 * quietly dropping it from the list would misrepresent what was sent.
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

/**
 * Whether the low-signal filter applies, for the three surfaces that render
 * issues.
 *
 * `hideLowSignal` is only honoured while scoring itself is on, so turning
 * scoring off restores the full list without the user also having to find
 * this second toggle.
 */
export function shouldHideLowSignal(settings: UserSettings | null | undefined): boolean {
  return (settings?.jev?.issueScoring ?? false) && (settings?.jev?.hideLowSignal ?? true);
}
