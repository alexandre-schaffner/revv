import type { WalkthroughIssue } from '@revv/shared';

export type IssueSeverity = WalkthroughIssue['severity'];

/**
 * Canonical render order for severity buckets — most severe first so the
 * reviewer's eye lands on blockers before nice-to-knows. The walkthrough
 * stream emits issues in the order the model surfaces them; we re-bucket
 * for display but preserve original order *within* each bucket so the
 * step linkage (`→ Step N`) still reads in increasing step numbers.
 */
export const SEVERITY_ORDER: readonly IssueSeverity[] = ['critical', 'warning', 'info'] as const;

export const SEVERITY_LABELS: Record<IssueSeverity, string> = {
	critical: 'Critical',
	warning: 'Warning',
	info: 'Info',
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

export interface IssueGroupView extends Omit<IssueGroup, 'issues'> {
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
