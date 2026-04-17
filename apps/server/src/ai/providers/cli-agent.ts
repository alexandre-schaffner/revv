import { execSync } from 'node:child_process';
import type { RiskLevel, WalkthroughBlock, WalkthroughStreamEvent, MarkdownBlock, CodeBlock, DiffBlock, WalkthroughIssue } from '@revv/shared';
import type { PrFileMeta } from '../../services/GitHub';
import { CLI_WALKTHROUGH_TIMEOUT_MS, CLI_CACHE_TTL_MS } from '../../constants';
import { debug } from '../../logger';
import {
	buildWalkthroughPrompt,
	buildExplorationDescription,
} from '../prompts/walkthrough';

// ── CLI-specific system prompt ─────────────────────────────────────────────
// Uses tagged JSON lines so we can parse & stream blocks incrementally
// instead of waiting for the entire process to exit.

const WALKTHROUGH_CLI_SYSTEM_PROMPT = `You are analyzing a GitHub pull request for a code review walkthrough.

Your task:
1. First, explore the repository structure to understand the codebase context
2. Read the files changed in this PR and related files (tests, configs, imports)
3. Check for patterns, dependencies, and potential issues beyond the diff
4. Output the walkthrough as a series of tagged JSON lines (see format below)

## Output format

Output each piece on its OWN LINE using these exact tags. Each line must contain a complete, valid JSON object. Do NOT wrap in code fences.

First, output the summary:
@SUMMARY {"summary": "2-3 sentence summary of what this PR does and why", "risk_level": "low"}

Then output blocks (8-20 total), one per line:
@BLOCK {"type": "markdown", "id": "block-0", "order": 0, "content": "## Overview\\n\\nMarkdown content here..."}
@BLOCK {"type": "code", "id": "block-1", "order": 1, "filePath": "src/app.ts", "startLine": 10, "endLine": 20, "language": "typescript", "content": "const x = 1;", "annotation": "Key change here", "annotationPosition": "left"}
@BLOCK {"type": "diff", "id": "block-2", "order": 2, "filePath": "src/app.ts", "patch": "@@ -1,3 +1,4 @@...", "annotation": "Added new import", "annotationPosition": "right"}

For any concern you identify (security vulnerabilities, race conditions, missing tests, edge cases, breaking changes, performance issues), output an issue line AFTER the block(s) that explain it:
@ISSUE {"severity": "warning", "title": "Short title (10 words max)", "description": "Clear explanation of the concern and why it matters (1-3 sentences)", "block_orders": [2], "file_path": "src/app.ts", "start_line": 42, "end_line": 50}

- block_orders is REQUIRED and must contain at least one order number of a @BLOCK that was already emitted above. Reviewers click the issue card to jump to the first referenced block, so the link must exist.
- Prefer linking to the single block that most directly explains the concern. Include additional orders only when the reviewer genuinely needs more than one block to understand the issue.
- You can use file_path: null if the concern is PR-wide. severity must be "info", "warning", or "critical".

Finally, signal completion:
@DONE

Rules:
- EACH tagged line must be on a SINGLE line — escape newlines as \\n within JSON string values
- Start with a markdown overview block explaining the big picture

MARKDOWN BLOCKS ARE FULLY RENDERED — use rich markdown, not plain text:
- @BLOCK markdown "content" is rendered as GitHub-flavored markdown. Use the full toolkit (remember to \\n-escape):
  - Headings: "## Section", "### Subsection"
  - Emphasis: "**bold**" for key terms, "*italics*" for subtle emphasis
  - Inline code: \`SessionStore.refresh()\`, \`session_secret\`, file paths like \`src/auth/middleware.ts\`
  - Lists: bulleted (- item) or numbered (1. item), for enumerating cases, steps, or risks
  - Blockquotes: "> …" for callouts or quoted decisions
  - Links: "[label](https://…)" when referencing external docs/specs
  - Fenced code snippets (\`\`\`ts …\`\`\`) for TINY illustrative snippets that don't warrant a full @BLOCK code (one-liner type signatures, shell commands, pseudocode). Still prefer real @BLOCK code blocks for actual source.
- A markdown block that is just one flat sentence is almost always a missed opportunity. Add structure: a heading, a bolded term, a short bullet list of key points.
- DO NOT dump all your prose into annotations while leaving markdown blocks barebones. The markdown blocks ARE the narrative spine of the document — they deserve the richest, best-formatted prose.

READING RHYTHM (HIGH PRIORITY — the walkthrough MUST read like an article, not a code dump):
- The document alternates: **markdown → code/diff → markdown → code/diff → …**. Markdown blocks are the spine; code/diff blocks are the evidence. NEVER emit two code/diff blocks back-to-back.
- The markdown-to-code ratio should be roughly 1:1. Aim for **at least as many markdown @BLOCKs as code+diff @BLOCKs combined**. If you've emitted 5 code/diff blocks, you should have emitted ~5 (or more) markdown blocks. Count as you go.
- Use markdown headings ("## Heading" or "### Subheading") to introduce each new concept / section — do not dump blocks under one giant heading. A new area of the PR deserves its own heading, and every heading paragraph should be followed by 1-2 code/diff blocks, then a bridge paragraph, then possibly another block.
- Before each code/diff block, emit a short @BLOCK markdown (1-3 sentences) that names what the reader is about to see and why it matters. After a dense block, a one-sentence "so what" bridge ties it back to the narrative.
- Keep connective markdown blocks SHORT (1-3 sentences). Reserve longer markdown for section intros, multi-block concept summaries, or list-form takeaways. Many small paragraphs beats one long one.
- Example skeleton of a good section:
  @BLOCK {"type":"markdown",...,"content":"## Authentication flow\\n\\nThe PR replaces the static bearer token with a rotating session cookie. Here is the new issuance path:"}
  @BLOCK {"type":"code",...}
  @BLOCK {"type":"markdown",...,"content":"Note the cookie is signed with the new \`SESSION_SECRET\` — refresh happens on every authenticated request."}
  @BLOCK {"type":"diff",...}
  @BLOCK {"type":"markdown",...,"content":"### Why this matters\\n\\nShort paragraph connecting back to the big picture."}
- If you catch yourself about to emit a second code/diff block in a row, STOP and insert a markdown bridge first.

- Group changes by CONCEPT, not by file
- Use your file reading tools to get the actual code, not just the diff
- Check related tests, type definitions, and documentation
- Alternate annotation_position between "left" and "right" for visual variety
- Every @ISSUE MUST come AFTER the @BLOCK(s) that explain it, and MUST link to them via "block_orders". The linked block's ANNOTATION is the DETAILED explanation; the issue card is a short label that points to it.
- The @ISSUE card must be MINIMAL: a punchy "title" and a one-short-sentence "description" (≤ ~15 words). Do not cram analysis into the description — it is just a label for the issues list.
- The ANNOTATION on the linked @BLOCK (code or diff) is where the full explanation lives — and it should be substantially longer/richer than a normal annotation. Spell out: the concrete failure mode, why it matters in this codebase, the specific lines/paths involved, and the recommended fix. Multi-paragraph markdown is fine here (remember \\n-escaping), use **bold** for key terms and inline \`code\` references. Think of it as the body of a code-review comment, not a caption.
- Most other annotations stay concise (1-3 sentences). The long-form treatment is reserved for blocks that are targets of @ISSUE links.
- Never let the annotation just restate the issue card. If it isn't materially richer, expand it with context, example inputs, affected code paths, or the reasoning behind the fix.
- Generate 8-20 blocks total depending on PR complexity
- risk_level: "low" for straightforward changes, "medium" for critical paths/complexity, "high" for security/breaking changes
- Be direct — reviewers are engineers, not beginners
- Call @ISSUE for every concern — security, races, missing tests, edge cases, breaking changes. Always ALSO output a @BLOCK markdown explaining the concern in depth first, then reference its order in block_orders.`;

// ── CLI agent detection (cached) ─────────────────────────────────────────────

let cachedCliAuth: { result: boolean; expiresAt: number; agent: string } | null = null;

function isCliAgentAvailable(agent: 'opencode' | 'claude'): boolean {
	try {
		const result = execSync(`which ${agent}`, { encoding: 'utf-8', timeout: 3000 });
		return result.trim().length > 0;
	} catch {
		return false;
	}
}

export function checkCliAvailability(agent: 'opencode' | 'claude'): boolean {
	if (cachedCliAuth && Date.now() < cachedCliAuth.expiresAt && cachedCliAuth.agent === agent) {
		return cachedCliAuth.result;
	}

	const available = isCliAgentAvailable(agent);
	cachedCliAuth = { result: available, expiresAt: Date.now() + CLI_CACHE_TTL_MS, agent };
	return available;
}

// ── Tagged-line incremental parsing ─────────────────────────────────────────

/**
 * Normalize a raw block object from CLI JSON into a typed WalkthroughBlock.
 */
function normalizeBlock(raw: Record<string, unknown>, fallbackOrder: number): WalkthroughBlock {
	const type = (raw['type'] as string) ?? 'markdown';
	const id = (raw['id'] as string) ?? `block-${raw['order'] ?? fallbackOrder}`;
	const order = (raw['order'] as number) ?? fallbackOrder;

	if (type === 'code') {
		return {
			type: 'code',
			id,
			order,
			filePath: (raw['filePath'] as string) ?? '',
			startLine: (raw['startLine'] as number) ?? 0,
			endLine: (raw['endLine'] as number) ?? 0,
			language: (raw['language'] as string) ?? 'text',
			content: (raw['content'] as string) ?? '',
			annotation: (raw['annotation'] as string | null) ?? null,
			annotationPosition: (raw['annotationPosition'] as 'left' | 'right') ?? 'left',
		} satisfies CodeBlock;
	} else if (type === 'diff') {
		return {
			type: 'diff',
			id,
			order,
			filePath: (raw['filePath'] as string) ?? '',
			patch: (raw['patch'] as string) ?? '',
			annotation: (raw['annotation'] as string | null) ?? null,
			annotationPosition: (raw['annotationPosition'] as 'left' | 'right') ?? 'left',
		} satisfies DiffBlock;
	}
	return {
		type: 'markdown',
		id,
		order,
		content: (raw['content'] as string) ?? '',
	} satisfies MarkdownBlock;
}

/**
 * Scan accumulated text for complete tagged walkthrough lines.
 * Returns parsed events and the remaining (incomplete) text.
 */
function extractTaggedLines(
	text: string,
	blockCounter: { value: number },
): { events: WalkthroughStreamEvent[]; remaining: string } {
	const events: WalkthroughStreamEvent[] = [];
	let remaining = text;

	while (true) {
		const nlIdx = remaining.indexOf('\n');
		if (nlIdx === -1) break;

		const line = remaining.slice(0, nlIdx).trim();
		remaining = remaining.slice(nlIdx + 1);

		if (line.startsWith('@SUMMARY ')) {
			try {
				const data = JSON.parse(line.slice(9)) as { summary: string; risk_level: string };
				events.push({
					type: 'summary' as const,
					data: { summary: data.summary, riskLevel: (data.risk_level ?? 'low') as RiskLevel },
				});
			} catch {
				debug('walkthrough-cli', 'Failed to parse @SUMMARY line');
			}
		} else if (line.startsWith('@BLOCK ')) {
			try {
				const data = JSON.parse(line.slice(7)) as Record<string, unknown>;
				events.push({
					type: 'block' as const,
					data: normalizeBlock(data, blockCounter.value),
				});
				blockCounter.value++;
			} catch {
				debug('walkthrough-cli', 'Failed to parse @BLOCK line');
			}
		} else if (line.startsWith('@ISSUE ')) {
			try {
				const data = JSON.parse(line.slice(7)) as {
					severity: string;
					title: string;
					description: string;
					file_path?: string | null;
					start_line?: number | null;
					end_line?: number | null;
					block_orders?: number[] | null;
				};
				const blockIds = Array.isArray(data.block_orders)
					? data.block_orders
							.filter((o): o is number => typeof o === 'number' && Number.isInteger(o) && o >= 0)
							.map((o) => `block-${o}`)
					: [];
				const issue: WalkthroughIssue = {
					id: `issue-${blockCounter.value++}`,
					severity: (data.severity ?? 'info') as 'info' | 'warning' | 'critical',
					title: data.title ?? '',
					description: data.description ?? '',
					blockIds,
					...(data.file_path != null ? { filePath: data.file_path } : {}),
					...(data.start_line != null ? { startLine: data.start_line } : {}),
					...(data.end_line != null ? { endLine: data.end_line } : {}),
				};
				events.push({ type: 'issue' as const, data: issue });
			} catch {
				debug('walkthrough-cli', 'Failed to parse @ISSUE line');
			}
		} else if (line === '@DONE' || line.startsWith('@DONE')) {
			events.push({
				type: 'done' as const,
				data: {
					walkthroughId: '',
					tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
				},
			});
		}
		// Non-tagged lines are silently ignored (model preamble text, etc.)
	}

	return { events, remaining };
}

// ── Fallback: parse a single JSON blob (legacy format) ──────────────────────

function parseLegacyJsonBlob(fullText: string): {
	summary: string;
	risk_level: string;
	steps: WalkthroughBlock[];
} | null {
	let jsonText = fullText.trim();

	// Strip code fences
	const fenceMatch = jsonText.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
	if (fenceMatch?.[1]) {
		jsonText = fenceMatch[1].trim();
	}

	// If it doesn't start with '{', try to find the first '{' and last '}'
	if (!jsonText.startsWith('{')) {
		const firstBrace = jsonText.indexOf('{');
		const lastBrace = jsonText.lastIndexOf('}');
		if (firstBrace !== -1 && lastBrace > firstBrace) {
			jsonText = jsonText.slice(firstBrace, lastBrace + 1);
		}
	}

	try {
		return JSON.parse(jsonText) as { summary: string; risk_level: string; steps: WalkthroughBlock[] };
	} catch {
		return null;
	}
}

// ── CLI walkthrough streaming ───────────────────────────────────────────────

/**
 * Stream walkthrough via opencode or claude CLI.
 * Runs the CLI in the worktree so it can explore the actual source files.
 *
 * Blocks are streamed incrementally using tagged JSON lines (@SUMMARY, @BLOCK, @DONE).
 * Falls back to parsing a single JSON blob if the model doesn't use the tagged format.
 */
export function streamWalkthroughViaCLI(params: {
	pr: { title: string; body: string | null; sourceBranch: string; targetBranch: string; url: string };
	files: PrFileMeta[];
	worktreePath: string;
}, model?: string, agent: 'opencode' | 'claude' = 'opencode'): AsyncGenerator<WalkthroughStreamEvent> {
	const userMessage = WALKTHROUGH_CLI_SYSTEM_PROMPT + '\n\n---\n\n' + buildWalkthroughPrompt(params);

	return (async function* (): AsyncGenerator<WalkthroughStreamEvent> {
		try {
			debug('walkthrough-cli', 'Starting CLI walkthrough via:', agent, 'in:', params.worktreePath, 'model:', model ?? 'default');

			// Build CLI args — prompt is piped via stdin (not a positional arg) to
			// avoid OS argument-length limits on large PRs.
			const cliArgs = agent === 'claude'
				? [
						'claude',
						'-p',
						'--output-format', 'json',
						'--dangerously-skip-permissions',
						...(model ? ['--model', model] : []),
					]
				: [
						'opencode',
						'run',
						'--format', 'json',
						'--dangerously-skip-permissions',
						...(model ? ['--model', model] : []),
					];

			const proc = Bun.spawn(cliArgs, {
				cwd: params.worktreePath,
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			});

			console.error('[walkthrough-cli] proc spawned, pid:', proc.pid);

			// Pipe the prompt via stdin
			proc.stdin.write(userMessage);
			proc.stdin.end();

			// Collect stderr for error reporting AND log lines in real time
			const stderrLines: string[] = [];
			const stderrPromise = (async () => {
				const dec = new TextDecoder();
				for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
					const text = dec.decode(chunk, { stream: true });
					stderrLines.push(text);
					if (text.trim()) console.error('[walkthrough-cli] stderr:', text.trim().slice(0, 300));
				}
				return stderrLines.join('');
			})();

			const decoder = new TextDecoder();
			let buffer = '';
			let fullText = '';
			let streamedBlockCount = 0; // tracks how many blocks we've yielded incrementally
			let streamedSummary = false;
			let streamedDone = false;
			const blockCounter = { value: 0 };

			let killed = false;
			const timeoutId = setTimeout(() => {
				killed = true;
				proc.kill();
			}, CLI_WALKTHROUGH_TIMEOUT_MS);

			try {
				for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
					buffer += decoder.decode(chunk, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed) continue;

					let msg: {
						type: string;
						part?: {
							type?: string;
							text?: string;
							tool?: string;
							reason?: string;
							state?: { status?: string; input?: unknown; output?: string };
							time?: unknown;
						};
					};
						try {
							msg = JSON.parse(trimmed) as typeof msg;
						} catch {
							continue;
						}

						if (msg.type === 'text' && msg.part?.type === 'text' && msg.part.text) {
							fullText += msg.part.text;

							// Incrementally extract tagged walkthrough lines
							const extracted = extractTaggedLines(fullText, blockCounter);
							fullText = extracted.remaining;

						for (const evt of extracted.events) {
							if (evt.type === 'summary') streamedSummary = true;
							if (evt.type === 'block') {
								// If the model skipped @SUMMARY and went straight to blocks,
								// synthesize a placeholder summary so the client can render content.
								if (!streamedSummary) {
									streamedSummary = true;
									yield {
										type: 'summary' as const,
										data: { summary: 'Walkthrough generated.', riskLevel: 'low' as RiskLevel },
									};
								}
								streamedBlockCount++;
							}
							if (evt.type === 'done') streamedDone = true;
							yield evt;
						}

						// @DONE may be the last output without a trailing newline —
							// detect it in the remaining buffer so we don't wait for process exit.
							if (!streamedDone && fullText.trim() === '@DONE') {
								streamedDone = true;
								yield {
									type: 'done' as const,
									data: {
										walkthroughId: '',
										tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
									},
								};
								fullText = '';
							}
						} else if (msg.type === 'tool_use' && msg.part?.tool) {
							const description = buildExplorationDescription(msg.part.tool, msg.part.state?.input);
							yield { type: 'exploration' as const, data: { tool: msg.part.tool, description } };
						} else if (msg.type === 'step_finish' && msg.part?.reason === 'stop') {
							// OpenCode signals end-of-response — model is done generating.
							// If we have a walkthrough but @DONE was missing, synthesize it.
							if (!streamedDone && streamedSummary && streamedBlockCount > 0) {
								// Flush any remaining tagged lines in fullText
								if (fullText.trim()) {
									const extracted = extractTaggedLines(fullText + '\n', blockCounter);
									fullText = extracted.remaining;
								for (const evt of extracted.events) {
									if (evt.type === 'summary') streamedSummary = true;
									if (evt.type === 'block') {
										if (!streamedSummary) {
											streamedSummary = true;
											yield {
												type: 'summary' as const,
												data: { summary: 'Walkthrough generated.', riskLevel: 'low' as RiskLevel },
											};
										}
										streamedBlockCount++;
									}
									if (evt.type === 'done') streamedDone = true;
									yield evt;
								}
								}
								if (!streamedDone) {
									streamedDone = true;
									yield {
										type: 'done' as const,
										data: {
											walkthroughId: '',
											tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
										},
									};
								}
							}
						}
					}

					// Walkthrough is complete — stop reading stdout instead of
					// waiting for the CLI process to close it (which may never happen).
					if (streamedDone) {
						debug('walkthrough-cli', 'Walkthrough complete, breaking out of stdout loop');
						break;
					}
				}
			} finally {
				clearTimeout(timeoutId);
				// Kill subprocess if still running (e.g., guard aborted us via .return())
				// This prevents orphaned processes when the stream guard's inactivity
				// timeout fires and calls iter.return() on our generator.
				try { proc.kill(); } catch { /* already dead */ }
				console.error('[walkthrough-cli] proc exited with code:', proc.exitCode);
			}

			// Process remaining text (last line may lack trailing newline)
			if (fullText.trim()) {
				// Append a newline so extractTaggedLines can pick up the last line
				const extracted = extractTaggedLines(fullText + '\n', blockCounter);
			for (const evt of extracted.events) {
				if (evt.type === 'summary') streamedSummary = true;
				if (evt.type === 'block') {
					if (!streamedSummary) {
						streamedSummary = true;
						yield {
							type: 'summary' as const,
							data: { summary: 'Walkthrough generated.', riskLevel: 'low' as RiskLevel },
						};
					}
					streamedBlockCount++;
				}
				if (evt.type === 'done') streamedDone = true;
				yield evt;
			}
				fullText = extracted.remaining;
			}

			// If we broke out of the stdout loop early (walkthrough complete),
			// kill the process instead of waiting for it to exit on its own.
			let killedAfterComplete = false;
			if (streamedDone && !killed) {
				proc.kill();
				killedAfterComplete = true;
			}
			await proc.exited;

			const stderrText = await stderrPromise;

			// Timeout kill → error (but NOT if we killed after successful completion)
			if (killed && !killedAfterComplete) {
				yield { type: 'error' as const, data: { code: 'AiGenerationError', message: 'Walkthrough generation timed out after 10 minutes' } };
				return;
			}

			// Non-zero exit code → error (ignore if we killed after completion)
			if (!killedAfterComplete && proc.exitCode !== 0) {
				const errorMsg = stderrText.trim() || `${agent} exited with code ${proc.exitCode}`;
				yield { type: 'error' as const, data: { code: 'AiGenerationError', message: errorMsg } };
				return;
			}

			// If we already streamed blocks via tagged lines, just ensure done was sent
			if (streamedSummary && streamedBlockCount > 0) {
				debug('walkthrough-cli', 'Streamed incrementally:', streamedBlockCount, 'blocks');
				if (!streamedDone) {
					yield {
						type: 'done' as const,
						data: {
							walkthroughId: '',
							tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
						},
					};
				}
				return;
			}

			// ── Fallback: parse as a single JSON blob (legacy format) ────────
			debug('walkthrough-cli', 'No tagged lines found, trying legacy JSON parse. Text length:', fullText.length);

			const parsed = parseLegacyJsonBlob(fullText);
			if (!parsed) {
				const preview = fullText.length > 500 ? fullText.slice(0, 500) + '...' : fullText;
				const errMsg = stderrText.trim()
					? `${agent} error: ${stderrText.trim()}`
					: `${agent} returned unexpected output: ${preview || '(empty)'}`;
				yield { type: 'error' as const, data: { code: 'AiGenerationError', message: errMsg } };
				return;
			}

			debug('walkthrough-cli', 'Legacy parse: yielding summary, riskLevel:', parsed.risk_level);
			yield { type: 'summary' as const, data: { summary: parsed.summary, riskLevel: parsed.risk_level as RiskLevel } };

			debug('walkthrough-cli', 'Legacy parse: yielding', parsed.steps.length, 'blocks');
			for (const block of parsed.steps) {
				yield { type: 'block' as const, data: block };
			}

			yield {
				type: 'done' as const,
				data: {
					walkthroughId: '',
					tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
				},
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			yield { type: 'error' as const, data: { code: 'AiGenerationError', message } };
		}
	})();
}

// ── Dynamic model listing ─────────────────────────────────────────────────────

export type CliModelOption = { label: string; value: string };

/**
 * List models available to the selected CLI agent.
 * For opencode: runs `opencode models --verbose` and parses output.
 * For claude: returns a hardcoded list (no offline model listing available).
 */
export async function listCliModels(agent: 'opencode' | 'claude'): Promise<CliModelOption[]> {
  if (agent === 'claude') {
    return [
      { label: 'Claude Opus 4.6', value: 'claude-opus-4-6' },
      { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
      { label: 'Claude Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
      { label: 'Claude Opus 4.5', value: 'claude-opus-4-5-20251101' },
      { label: 'Claude Sonnet 4.5', value: 'claude-sonnet-4-5-20250929' },
      { label: 'Claude Opus 4.0', value: 'claude-opus-4-20250514' },
      { label: 'Claude Sonnet 4.0', value: 'claude-sonnet-4-20250514' },
      { label: 'Claude Haiku 4.0', value: 'claude-haiku-4-20250414' },
    ];
  }

  // opencode: run `opencode models --verbose` and parse interleaved output
  // Format: line with "provider/id", then JSON blob with model metadata, repeated
  try {
    const proc = Bun.spawn(['opencode', 'models', '--verbose'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;

    const models: CliModelOption[] = [];
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]?.trim();
      if (!line) { i++; continue; }

      // Check if this line looks like a model ID (e.g. "provider/model-id")
      if (!line.startsWith('{') && line.includes('/')) {
        const modelId = line;
        // Next non-empty content should be a JSON blob — collect until balanced braces
        let jsonStr = '';
        let depth = 0;
        i++;
        while (i < lines.length) {
          const jsonLine = lines[i] ?? '';
          jsonStr += jsonLine + '\n';
          for (const ch of jsonLine) {
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
          }
          i++;
          if (depth === 0 && jsonStr.trim().startsWith('{')) break;
        }
        try {
          const meta = JSON.parse(jsonStr.trim()) as { name?: string; providerID?: string };
          const label = meta.name ?? modelId;
          models.push({ label, value: modelId });
        } catch {
          models.push({ label: modelId, value: modelId });
        }
      } else {
        i++;
      }
    }
    return models;
  } catch {
    // Fallback: empty list (frontend will show empty state)
    return [];
  }
}
