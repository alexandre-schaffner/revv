// ── Chat prompt ─────────────────────────────────────────────────────────────
//
// Right-pane AI chat system prompt + user-message builders. The agent runs
// inside the PR's git worktree, with read AND write tool access (Read, Grep,
// Glob, Write, Edit, Bash) so it can propose fixes as actual commits on a
// working branch.
//
// The system prompt is sent ONCE on session create — both the Claude Agent
// SDK (`persistSession: true`) and the opencode daemon retain it for resumes.

import { readFileSync } from 'fs';

const CHAT_SYSTEM_TEMPLATE: string = readFileSync(
	import.meta.dir + '/chat-system.md',
	'utf-8',
);

export interface ChatWalkthroughIssue {
	readonly severity: string; // 'info' | 'warning' | 'critical'
	readonly title: string;
	readonly description: string;
	readonly filePath?: string | null;
	readonly startLine?: number | null;
	readonly endLine?: number | null;
}

export interface ChatWalkthroughContext {
	readonly summary: string;
	readonly riskLevel: string;
	readonly sentiment: string | null;
	readonly issues: ReadonlyArray<ChatWalkthroughIssue>;
}

export interface ChatPrContext {
	readonly title: string;
	readonly body: string | null;
	readonly sourceBranch: string;
	readonly targetBranch: string;
}

export interface ChatSystemPromptParams {
	readonly pr: ChatPrContext;
	readonly walkthrough?: ChatWalkthroughContext | null;
	readonly branchName: string;
}

/**
 * System prompt for the right-pane chat agent. Embeds PR context + the
 * latest walkthrough (when available) and explains the write+commit
 * workflow. Sent only on session create.
 */
export function buildChatSystemPrompt(params: ChatSystemPromptParams): string {
	// Build PR section
	const prLines: string[] = [];
	prLines.push('## Pull Request');
	prLines.push(`**Title:** ${params.pr.title}`);
	prLines.push(
		`**Branch:** \`${params.pr.sourceBranch}\` → \`${params.pr.targetBranch}\``,
	);
	if (params.pr.body?.trim()) {
		prLines.push('');
		prLines.push('**Description:**');
		prLines.push(params.pr.body.trim());
	}
	const prSection = prLines.join('\n');

	// Build walkthrough section (empty string when absent)
	let walkthroughSection = '';
	if (params.walkthrough) {
		const wt = params.walkthrough;
		const wtLines: string[] = [];
		wtLines.push('## Walkthrough Analysis');
		wtLines.push(`**Risk Level:** ${wt.riskLevel}`);
		if (wt.summary.trim()) {
			wtLines.push('');
			wtLines.push('**Summary:**');
			wtLines.push(wt.summary.trim());
		}
		if (wt.sentiment?.trim()) {
			wtLines.push('');
			wtLines.push('**Overall Sentiment:**');
			wtLines.push(wt.sentiment.trim());
		}
		if (wt.issues.length > 0) {
			wtLines.push('');
			wtLines.push('**Issues Found:**');
			for (const issue of wt.issues) {
				const where = issue.filePath
					? issue.startLine != null
						? ` — \`${issue.filePath}:${issue.startLine}${
								issue.endLine != null && issue.endLine !== issue.startLine
									? `–${issue.endLine}`
									: ""
							}\``
						: ` — \`${issue.filePath}\``
					: "";
				wtLines.push(
					`- [${issue.severity.toUpperCase()}]${where} **${issue.title}**: ${issue.description}`,
				);
			}
		}
		walkthroughSection = wtLines.join('\n');
	}

	// Fill placeholders
	let prompt = CHAT_SYSTEM_TEMPLATE
		.replace('{{PR_SECTION}}', prSection)
		.replace('{{BRANCH_NAME}}', params.branchName);

	if (walkthroughSection) {
		prompt = prompt.replace('{{WALKTHROUGH_SECTION}}', walkthroughSection);
	} else {
		// Remove the placeholder along with its surrounding blank lines
		prompt = prompt.replace('\n\n{{WALKTHROUGH_SECTION}}', '');
	}

	// Clean up any double-blank-lines that may result from empty sections
	prompt = prompt.replace(/\n{3,}/g, '\n\n');

	return prompt;
}

export function buildChatUserMessage(params: { message: string }): string {
	return params.message;
}
