import type { IssueSeverity } from "@revv/shared";

export const ISSUE_RELEVANCE_TIMEOUT_MS = 15_000;
export const ISSUE_RELEVANCE_CACHE_NS = "jev:issue-relevance";
export const ISSUE_RELEVANCE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const WEIGHTS = {
  grounded: 0.4,
  in_scope: 0.25,
  actionable: 0.2,
  novel: 0.15,
} as const;

export const SEVERITY_LEVELS = [
  "A nit: style, taste, or a preference the author could reasonably decline.",
  "Worth knowing: useful context or a minor improvement, but merging without it is fine.",
  "Should fix before merge: a real defect or risk, though not one that would stop a release.",
  "Must fix: merging this as-is would cause an incident, lose data, or break users.",
] as const;

export const MUST_FIX_LEVEL = SEVERITY_LEVELS.length - 1;

export interface RawIssueJudgment {
  readonly score: number;
  readonly severityLevel: number;
}

export function severityForLevel(level: number): IssueSeverity {
  const rounded = Math.round(level);
  if (rounded >= MUST_FIX_LEVEL) return "critical";
  if (rounded >= 2) return "warning";
  return "info";
}

/** Pure policy: collapse rubric answers into a score and apply the safety floor. */
export function compositeScore(input: {
  readonly grounded: number;
  readonly in_scope: number;
  readonly actionable: number;
  readonly novel: number;
  readonly severity: number;
  readonly declaredSeverity: string;
}): number {
  const weighted =
    WEIGHTS.grounded * input.grounded +
    WEIGHTS.in_scope * input.in_scope +
    WEIGHTS.actionable * input.actionable +
    WEIGHTS.novel * input.novel;
  const protectedIssue =
    input.declaredSeverity === "critical" || input.severity >= MUST_FIX_LEVEL - 0.5;
  return protectedIssue ? Math.max(weighted, 1) : weighted;
}
