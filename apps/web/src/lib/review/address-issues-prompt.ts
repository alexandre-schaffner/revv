import type { WalkthroughIssue } from "@revv/shared";
import addressIssuesTemplate from "./address-issues.md?raw";
import { ISSUE_SEVERITY_TAG, issueLocation } from "./issue-text";

/**
 * The first chat message when the user clicks "Generate changes" in Your
 * review: each selected issue, to be addressed as separate commits.
 */
export function buildAddressIssuesPrompt(issues: ReadonlyArray<WalkthroughIssue>): string {
  if (issues.length === 0) {
    return "Please address the issues flagged in the walkthrough above.";
  }

  const issueLines: string[] = [];
  issues.forEach((issue, i) => {
    const location = issueLocation(issue);
    const loc = location ? ` — \`${location}\`` : "";
    issueLines.push(
      `${i + 1}. **${ISSUE_SEVERITY_TAG[issue.severity]}** ${issue.title}${loc}`,
      `   ${issue.description}`,
      "",
    );
  });
  const issuesList = issueLines.join("\n");

  return addressIssuesTemplate.replace("{{ISSUES_LIST}}", `${issuesList}\n`);
}
