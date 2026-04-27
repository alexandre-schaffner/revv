// ── Frontend prompt builders ───────────────────────────────────────────────
//
// User-facing chat prompts that we ship as the first message of a session.
// Lives in the web bundle (not @revv/shared) because it's UI-driven and
// references issue shapes that are already in the web app.

import type { WalkthroughIssue } from '@revv/shared';
import addressIssuesTemplate from './address-issues.md?raw';

function severityTag(s: WalkthroughIssue['severity']): string {
	switch (s) {
		case 'critical':
			return '[CRITICAL]';
		case 'warning':
			return '[WARNING]';
		default:
			return '[INFO]';
	}
}

function locationOf(issue: WalkthroughIssue): string {
	if (!issue.filePath) return '';
	if (issue.startLine == null) return ` — \`${issue.filePath}\``;
	if (issue.endLine != null && issue.endLine !== issue.startLine) {
		return ` — \`${issue.filePath}:${issue.startLine}–${issue.endLine}\``;
	}
	return ` — \`${issue.filePath}:${issue.startLine}\``;
}

/**
 * Build the auto-prompt sent when the user clicks "Generate changes" in the
 * Request Changes tab. Bundles each selected walkthrough issue and asks the
 * agent to address them as separate commits using its Edit/Write/Bash tools.
 */
export function buildAddressIssuesPrompt(
	issues: ReadonlyArray<WalkthroughIssue>,
): string {
	if (issues.length === 0) {
		return 'Please address the issues flagged in the walkthrough above.';
	}

	const issueLines: string[] = [];
	issues.forEach((issue, i) => {
		const tag = severityTag(issue.severity);
		const loc = locationOf(issue);
		issueLines.push(
			`${i + 1}. **${tag}** ${issue.title}${loc}`,
			`   ${issue.description}`,
			'',
		);
	});
	const issuesList = issueLines.join('\n');

	return addressIssuesTemplate.replace('{{ISSUES_LIST}}', issuesList + '\n');
}
