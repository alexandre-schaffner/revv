// The body of a GitHub review: the walkthrough issues the reviewer picked.

import type { IssueSeverity, WalkthroughIssue } from "@revv/shared";

// Plain-text tags: the posted markdown stays icon-free.
function severityTag(s: IssueSeverity): string {
  return s === "critical" ? "`[CRITICAL]`" : s === "warning" ? "`[WARNING]`" : "`[INFO]`";
}

export function reviewBody(issues: readonly WalkthroughIssue[]): string {
  if (issues.length === 0) return "";
  const lines = issues.map((issue) => {
    const range =
      issue.endLine != null && issue.endLine !== issue.startLine ? `–${issue.endLine}` : "";
    const loc =
      issue.filePath && issue.startLine != null
        ? ` (\`${issue.filePath}:${issue.startLine}${range}\`)`
        : issue.filePath
          ? ` (\`${issue.filePath}\`)`
          : "";
    return `- ${severityTag(issue.severity)} **${issue.title}**${loc}\n  ${issue.description}`;
  });
  return ["### Walkthrough issues", ...lines].join("\n\n");
}
