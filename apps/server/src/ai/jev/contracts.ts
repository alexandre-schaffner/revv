import type { IssueSeverity, WalkthroughStreamEvent } from "@revv/shared";

/** Neutral DTO shared by the Phase-B tool surface and Jev hooks. */
export interface IssueCandidate {
  readonly severity: string;
  readonly title: string;
  readonly description: string;
  readonly filePath: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

/** What the issue gate decided. Persisted on the row when the concern is kept. */
export interface IssueJudgment {
  readonly score: number;
  readonly lowSignal: boolean;
  readonly discard: boolean;
  readonly severity: IssueSeverity | null;
}

/** What a background judgment needs to tell the active walkthrough. */
export interface JudgmentSink {
  readonly emit: (event: WalkthroughStreamEvent) => void;
  readonly broadcastThread: (threadId: string) => void;
}
