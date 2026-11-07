import type { WalkthroughIssue } from "@revv/shared";
import { ISSUE_SEVERITY_TAG, issueLocation } from "./issue-text";

export function reviewBody(issues: readonly WalkthroughIssue[]): string {
  if (issues.length === 0) return "";
  const lines = issues.map((issue) => {
    const location = issueLocation(issue);
    const loc = location ? ` (\`${location}\`)` : "";
    const tag = `\`${ISSUE_SEVERITY_TAG[issue.severity]}\``;
    return `- ${tag} **${issue.title}**${loc}\n  ${issue.description}`;
  });
  return ["### Walkthrough issues", ...lines].join("\n\n");
}
