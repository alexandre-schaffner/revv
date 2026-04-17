import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type {
	WalkthroughStreamEvent,
	WalkthroughIssue,
	MarkdownBlock,
	CodeBlock,
	DiffBlock,
	RiskLevel,
} from '@revv/shared';

// ── Emitter interface ───────────────────────────────────────────────────────

export interface WalkthroughEmitter {
	emit: (event: WalkthroughStreamEvent) => void;
	state: {
		summarySet: boolean;
		blockCount: number;
		issueCount: number;
		completed: boolean;
		writingPhaseEmitted: boolean;
	};
}

// ── MCP server factory ──────────────────────────────────────────────────────

export function createWalkthroughMcpServer(
	emitter: WalkthroughEmitter,
	initialState?: { summarySet: boolean; blockCount: number; issueCount: number },
) {
	// Merge initial state if provided (used for continuation/resume)
	if (initialState) {
		emitter.state.summarySet = initialState.summarySet;
		emitter.state.blockCount = initialState.blockCount;
		emitter.state.issueCount = initialState.issueCount;
	}
	return createSdkMcpServer({
		name: 'rev-walkthrough',
		version: '1.0.0',
		tools: [
			// ── set_walkthrough_summary ──────────────────────────────────
			tool(
				'set_walkthrough_summary',
				'Set the PR summary and risk level. Must be called exactly once, before any other walkthrough tools.',
				{
					summary: z.string().describe('2-3 sentence summary of what this PR does and why'),
					risk_level: z.enum(['low', 'medium', 'high']).describe('Overall risk assessment'),
				},
				async (args) => {
					if (emitter.state.summarySet) {
						return { content: [{ type: 'text' as const, text: 'Error: summary already set. You can only call set_walkthrough_summary once.' }], isError: true };
					}
					emitter.state.summarySet = true;
					emitter.emit({
						type: 'summary',
						data: { summary: args.summary, riskLevel: args.risk_level as RiskLevel },
					});
					return { content: [{ type: 'text' as const, text: 'Summary set successfully. Now add walkthrough blocks.' }] };
				},
			),

			// ── add_markdown_section ─────────────────────────────────────
			tool(
				'add_markdown_section',
				'Add a markdown text section to the walkthrough. Use for explanations, headings, analysis, concerns, and lists.',
				{
					content: z.string().describe('Markdown content (headings, paragraphs, lists, inline code). Use ## for section headings.'),
				},
				async (args) => {
					if (!emitter.state.summarySet) {
						return { content: [{ type: 'text' as const, text: 'Error: call set_walkthrough_summary first.' }], isError: true };
					}
					if (emitter.state.completed) {
						return { content: [{ type: 'text' as const, text: 'Error: walkthrough already completed.' }], isError: true };
					}
					if (!emitter.state.writingPhaseEmitted) {
						emitter.state.writingPhaseEmitted = true;
						emitter.emit({ type: 'phase', data: { phase: 'writing', message: 'Building walkthrough...' } });
					}
					const block: MarkdownBlock = {
						type: 'markdown',
						id: `block-${emitter.state.blockCount}`,
						order: emitter.state.blockCount,
						content: args.content,
					};
					emitter.state.blockCount++;
					emitter.emit({ type: 'block', data: block });
					return { content: [{ type: 'text' as const, text: `Markdown section added (block ${block.order}).` }] };
				},
			),

			// ── add_code_block ───────────────────────────────────────────
			tool(
				'add_code_block',
				'Add an annotated code block showing source code from a specific file. Use to highlight important code the reviewer should see.',
				{
					file_path: z.string().describe('Relative path to the source file'),
					start_line: z.number().int().describe('Starting line number'),
					end_line: z.number().int().describe('Ending line number'),
					language: z.string().describe('Programming language for syntax highlighting (e.g. typescript, python, go)'),
					content: z.string().describe('The actual code text to display'),
					annotation: z.string().nullable().describe('Explanatory note displayed alongside the code, or null for no annotation'),
					annotation_position: z.enum(['left', 'right']).describe('Which side to display the annotation relative to the code'),
				},
				async (args) => {
					if (!emitter.state.summarySet) {
						return { content: [{ type: 'text' as const, text: 'Error: call set_walkthrough_summary first.' }], isError: true };
					}
					if (emitter.state.completed) {
						return { content: [{ type: 'text' as const, text: 'Error: walkthrough already completed.' }], isError: true };
					}
					if (!emitter.state.writingPhaseEmitted) {
						emitter.state.writingPhaseEmitted = true;
						emitter.emit({ type: 'phase', data: { phase: 'writing', message: 'Building walkthrough...' } });
					}
					const block: CodeBlock = {
						type: 'code',
						id: `block-${emitter.state.blockCount}`,
						order: emitter.state.blockCount,
						filePath: args.file_path,
						startLine: args.start_line,
						endLine: args.end_line,
						language: args.language,
						content: args.content,
						annotation: args.annotation,
						annotationPosition: args.annotation_position,
					};
					emitter.state.blockCount++;
					emitter.emit({ type: 'block', data: block });
					return { content: [{ type: 'text' as const, text: `Code block added: ${args.file_path}:${args.start_line}-${args.end_line} (block ${block.order}).` }] };
				},
			),

			// ── add_diff_block ───────────────────────────────────────────
			tool(
				'add_diff_block',
				'Add an annotated diff block showing changes in unified diff format. Use to highlight specific changes the reviewer should focus on.',
				{
					file_path: z.string().describe('Path to the changed file'),
					patch: z.string().describe('Unified diff patch text (with @@ hunk headers)'),
					annotation: z.string().nullable().describe('Explanatory note displayed alongside the diff, or null for no annotation'),
					annotation_position: z.enum(['left', 'right']).describe('Which side to display the annotation relative to the diff'),
				},
				async (args) => {
					if (!emitter.state.summarySet) {
						return { content: [{ type: 'text' as const, text: 'Error: call set_walkthrough_summary first.' }], isError: true };
					}
					if (emitter.state.completed) {
						return { content: [{ type: 'text' as const, text: 'Error: walkthrough already completed.' }], isError: true };
					}
					if (!emitter.state.writingPhaseEmitted) {
						emitter.state.writingPhaseEmitted = true;
						emitter.emit({ type: 'phase', data: { phase: 'writing', message: 'Building walkthrough...' } });
					}
					const block: DiffBlock = {
						type: 'diff',
						id: `block-${emitter.state.blockCount}`,
						order: emitter.state.blockCount,
						filePath: args.file_path,
						patch: args.patch,
						annotation: args.annotation,
						annotationPosition: args.annotation_position,
					};
					emitter.state.blockCount++;
					emitter.emit({ type: 'block', data: block });
					return { content: [{ type: 'text' as const, text: `Diff block added: ${args.file_path} (block ${block.order}).` }] };
				},
			),

			// ── flag_issue ───────────────────────────────────────────────────────
			tool(
				'flag_issue',
				'Flag a structured concern or issue found in the PR. Call this for every concern you identify — security vulnerabilities, race conditions, missing tests, edge cases, breaking changes, etc. You can call this alongside your narrative markdown sections.',
				{
					severity: z.enum(['info', 'warning', 'critical']).describe(
						'info: minor note; warning: should be addressed before merge; critical: blocks merge or introduces serious risk'
					),
					title: z.string().describe('Short title of the concern (10 words max)'),
					description: z.string().describe('Clear explanation of the concern and why it matters (1-3 sentences)'),
					file_path: z.string().nullable().describe('Path to the relevant file, or null if PR-wide'),
					start_line: z.number().int().nullable().describe('Starting line number of the concern, or null'),
					end_line: z.number().int().nullable().describe('Ending line number of the concern, or null'),
				},
				async (args) => {
					if (!emitter.state.summarySet) {
						return { content: [{ type: 'text' as const, text: 'Error: call set_walkthrough_summary first.' }], isError: true };
					}
					if (emitter.state.completed) {
						return { content: [{ type: 'text' as const, text: 'Error: walkthrough already completed.' }], isError: true };
					}
					const issue: WalkthroughIssue = {
						id: `issue-${emitter.state.issueCount}`,
						severity: args.severity,
						title: args.title,
						description: args.description,
						...(args.file_path !== null ? { filePath: args.file_path } : {}),
						...(args.start_line !== null ? { startLine: args.start_line } : {}),
						...(args.end_line !== null ? { endLine: args.end_line } : {}),
					};
					emitter.state.issueCount++;
					emitter.emit({ type: 'issue', data: issue });
					return { content: [{ type: 'text' as const, text: `Issue flagged: [${issue.severity}] ${issue.title}` }] };
				},
			),

			// ── complete_walkthrough ─────────────────────────────────────
			tool(
				'complete_walkthrough',
				'Signal that the walkthrough is complete. Call this once after all sections and blocks have been added.',
				{},
				async () => {
					if (emitter.state.completed) {
						return { content: [{ type: 'text' as const, text: 'Error: walkthrough already completed.' }], isError: true };
					}
					emitter.state.completed = true;
					// Emit done immediately so the client stops showing "Generating...".
					// The outer generator may emit a second done with real token usage —
					// the client handles it idempotently and the server overwrites with the
					// real values for cache.
					emitter.emit({
						type: 'done',
						data: {
							walkthroughId: '',
							tokenUsage: {
								inputTokens: 0,
								outputTokens: 0,
								cacheReadInputTokens: 0,
								cacheCreationInputTokens: 0,
							},
						},
					});
					return { content: [{ type: 'text' as const, text: 'Walkthrough complete.' }] };
				},
			),
		],
	});
}
