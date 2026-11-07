import type { IssueSeverity } from "@revv/shared";

/** Neutral DTO shared by the Phase-B tool surface and the issue judgment. */
export interface IssueCandidate {
  readonly severity: IssueSeverity;
  readonly title: string;
  readonly description: string;
  readonly filePath: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

/** What the issue judgment decided. Persisted on the row when the concern is kept. */
export interface IssueJudgment {
  readonly score: number;
  readonly lowSignal: boolean;
  readonly discard: boolean;
  readonly severity: IssueSeverity | null;
}
