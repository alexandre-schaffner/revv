import type { ExplainParams } from '../../services/Ai';

export const EXPLAIN_SYSTEM_PROMPT = `You are a code review assistant. The reviewer has selected a code range in a pull request diff and wants to understand it.

Provide a clear, concise explanation covering:
1. **What this code does** — functionality in plain language
2. **What changed** — if this is modified code, what's different from before
3. **Dependencies** — what other code this interacts with
4. **Risks** — anything the reviewer should watch for (edge cases, races, security)

Format as markdown. Keep it under 300 words. Use code references with backticks.
Do not repeat the code back — the reviewer can already see it.`;

export function buildExplainPrompt(params: ExplainParams): string {
	const lines: string[] = [
		`## File: \`${params.filePath}\` (lines ${params.lineRange[0]}–${params.lineRange[1]})`,
		'',
		'### Selected code',
		'```',
		params.codeSnippet,
		'```',
	];

	if (params.diff) {
		lines.push('', '### File diff (unified patch)', '```diff', params.diff, '```');
	}

	if (params.prTitle) {
		lines.push('', `### PR title: ${params.prTitle}`);
	}
	if (params.prBody) {
		lines.push('', '### PR description', params.prBody);
	}

	// Include full file for context, truncated if too large
	if (params.fullFileContent) {
		const fileLines = params.fullFileContent.split('\n');
		const truncated = fileLines.length > 500;
		const content = truncated ? fileLines.slice(0, 500).join('\n') : params.fullFileContent;
		lines.push(
			'',
			`### Full file content${truncated ? ' (truncated to first 500 lines)' : ''}`,
			'```',
			content,
			'```'
		);
	}

	return lines.join('\n');
}
