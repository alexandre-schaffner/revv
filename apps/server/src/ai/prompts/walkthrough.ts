import type { PrFileMeta } from '../../services/GitHub';
import type { WalkthroughBlock } from '@revv/shared';

// ── Continuation context (imported here to avoid circular deps) ──────────────

export interface PromptContinuationContext {
	walkthroughId: string;
	existingBlocks: WalkthroughBlock[];
}

// ── MCP-based walkthrough prompt (used with tool calls) ─────────────────────

export const WALKTHROUGH_MCP_SYSTEM_PROMPT = `You are an expert code reviewer analyzing a GitHub pull request. Your task is to create a guided walkthrough that helps the reviewer understand the PR quickly and thoroughly.

You have access to file exploration tools (Read, Grep, Glob) to examine the codebase, and walkthrough tools to build the review document incrementally.

## Workflow
1. First, explore the repository using Read, Grep, and Glob to understand the changes in context — read changed files, related tests, type definitions, and documentation
2. Call set_walkthrough_summary with a concise summary and risk assessment
3. Build the walkthrough by calling add_markdown_section, add_code_block, and add_diff_block in a natural reading order
4. Call complete_walkthrough when finished

## Structure guidelines
- Start with a markdown overview section explaining the purpose, scope, and key decisions
- Alternate between explanatory markdown and code/diff blocks to create a pleasant reading flow
- Group changes by CONCEPT, not by file — a section can reference multiple files
- Use add_code_block to show important source code the reviewer should see (use actual code from files you read)
- Use add_diff_block to highlight specific changes with their unified diff
- Use annotations on code/diff blocks to point out what the reviewer should notice — keep annotations concise (1-3 sentences)
- Alternate annotation_position between 'left' and 'right' for visual variety
- For every concern you identify (security, races, missing tests, edge cases, breaking changes, performance), call flag_issue to register a structured issue. You can still describe the concern in your narrative markdown, but always also call flag_issue so it appears in the reviewer's issues list.
- Use severity 'critical' for security vulnerabilities or blocking problems, 'warning' for things that should be fixed before merge, 'info' for minor observations
- Aim for 8-20 blocks total depending on PR complexity
- Be direct — reviewers are engineers, not beginners

## Risk level guide
- low: straightforward changes, good test coverage, limited blast radius
- medium: touches critical paths, some edge cases to verify, moderate complexity
- high: security-sensitive, breaking changes, missing tests for critical paths, concurrency concerns`;

// ── Helpers ─────────────────────────────────────────────────────────────────

export function buildExplorationDescription(toolName: string, input: unknown): string {
	const inp = input as Record<string, string> | null | undefined;
	switch (toolName) {
		case 'Read':
			return `Reading ${inp?.['file_path'] ?? 'file'}`;
		case 'Grep':
			return `Searching for '${inp?.['pattern'] ?? ''}' in ${inp?.['path'] ?? 'codebase'}`;
		case 'Glob':
			return `Finding files matching ${inp?.['pattern'] ?? '*'}`;
		case 'LS':
			return `Listing ${inp?.['path'] ?? '.'}`;
		default:
			return `Using ${toolName}`;
	}
}

export function buildWalkthroughPrompt(params: {
	pr: { title: string; body: string | null; sourceBranch: string; targetBranch: string; url: string };
	files: PrFileMeta[];
}, maxTokenBudget = 40000, continuation?: PromptContinuationContext): string {
	const lines: string[] = [
		`## Pull Request: ${params.pr.title}`,
		`Branch: ${params.pr.sourceBranch} → ${params.pr.targetBranch}`,
	];
	if (params.pr.body) {
		lines.push('', '### Description', params.pr.body);
	}
	lines.push(
		'',
		'### Changed Files (diff — you can read full file contents with your tools)',
		''
	);

	let approxTokens = 0;
	for (const file of params.files) {
		const header = `#### ${file.filename} (${file.status}, +${file.additions} -${file.deletions})`;
		if (file.patch) {
			const patchTokens = file.patch.length / 4;
			if (approxTokens + patchTokens > maxTokenBudget) {
				lines.push(header, '[PATCH OMITTED — context limit reached]', '');
				continue;
			}
			lines.push(header, '```diff', file.patch, '```', '');
			approxTokens += patchTokens;
		} else {
			lines.push(header, '[No patch available — binary or too large]', '');
		}
	}
	if (continuation && continuation.existingBlocks.length > 0) {
		const N = continuation.existingBlocks.length;
		lines.push('', '## Continuation Mode');
		lines.push(
			`The following blocks have already been generated (do not repeat them):`,
		);
		for (const block of continuation.existingBlocks) {
			if (block.type === 'markdown') {
				const preview = block.content.slice(0, 80).replace(/\n/g, '\\n');
				lines.push(`[block ${block.order}]: markdown — "${preview}"`);
			} else if (block.type === 'code') {
				lines.push(`[block ${block.order}]: code — ${block.filePath}:${block.startLine}-${block.endLine}`);
			} else if (block.type === 'diff') {
				lines.push(`[block ${block.order}]: diff — ${block.filePath}`);
			}
		}
		lines.push(
			``,
			`Continue from block ${N}. Call add_markdown_section / add_code_block / add_diff_block to add NEW blocks only, starting at order index ${N}.`,
			`Do NOT call set_walkthrough_summary (already done).`,
		);
	}
	return lines.join('\n');
}
