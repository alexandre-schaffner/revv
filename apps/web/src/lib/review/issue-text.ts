// How an issue reads in markdown the reviewer sends on: the GitHub review
// body and the "address these issues" chat prompt.

import type { IssueSeverity, WalkthroughIssue } from "@revv/shared";

/** Plain-text tags: the posted markdown stays icon-free. */
export const ISSUE_SEVERITY_TAG: Readonly<Record<IssueSeverity, string>> = {
  critical: "[CRITICAL]",
  warning: "[WARNING]",
  info: "[INFO]",
};

/** `path:12–18`, `path:12` or `path`; null when the issue names no file. */
export function issueLocation(
  issue: Pick<WalkthroughIssue, "filePath" | "startLine" | "endLine">,
): string | null {
  if (!issue.filePath) return null;
  if (issue.startLine == null) return issue.filePath;
  const range =
    issue.endLine != null && issue.endLine !== issue.startLine ? `–${issue.endLine}` : "";
  return `${issue.filePath}:${issue.startLine}${range}`;
}
