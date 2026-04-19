import type {
	CodeBlock,
	DiffBlock,
	MarkdownBlock,
	RatingAxis,
	RatingCitation,
	RiskLevel,
	WalkthroughIssue,
	WalkthroughRating,
	WalkthroughStreamEvent,
} from "@revv/shared";
import { RATING_AXES } from "@revv/shared";
import { z } from "zod";

// ── State ────────────────────────────────────────────────────────────────────

export interface WalkthroughToolState {
	summarySet: boolean;
	blockCount: number;
	issueCount: number;
	completed: boolean;
	writingPhaseEmitted: boolean;
	ratedAxes: Set<RatingAxis>;
}

export function createInitialState(): WalkthroughToolState {
	return {
		summarySet: false,
		blockCount: 0,
		issueCount: 0,
		completed: false,
		writingPhaseEmitted: false,
		ratedAxes: new Set<RatingAxis>(),
	};
}

// ── Tool spec shape ──────────────────────────────────────────────────────────

export interface ToolSpec<TShape extends z.ZodRawShape> {
	name: string;
	description: string;
	inputSchema: z.ZodObject<TShape>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	handler: (
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		args: any,
		state: WalkthroughToolState,
		emit: (event: WalkthroughStreamEvent) => void,
	) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
}

// ── Tool specs ───────────────────────────────────────────────────────────────

const setSummarySchema = z.object({
	summary: z.string().describe("2-3 sentence summary of what this PR does and why"),
	risk_level: z.enum(["low", "medium", "high"]).describe("Overall risk assessment"),
});

const addMarkdownSchema = z.object({
	content: z
		.string()
		.describe(
			"GitHub-flavored markdown. USE THE FULL TOOLKIT: headings (## / ###), **bold** for key terms, *italics*, `inline code` for identifiers and paths, bulleted / numbered lists, > blockquotes, [links](url), and ```fenced``` snippets for tiny illustrative code. A single flat sentence is a missed opportunity — add a heading, a bold term, or a short bullet list. Do not push rich prose into annotations and leave this barebones.",
		),
});

const addCodeBlockSchema = z.object({
	file_path: z.string().describe("Relative path to the source file"),
	start_line: z.number().int().describe("Starting line number"),
	end_line: z.number().int().describe("Ending line number"),
	language: z
		.string()
		.describe("Programming language for syntax highlighting (e.g. typescript, python, go)"),
	content: z.string().describe("The actual code text to display"),
	annotation: z
		.string()
		.nullable()
		.describe(
			"Markdown note displayed alongside the code, or null for no annotation. Keep concise (1-3 sentences) for purely explanatory blocks. If this block will be the target of a flag_issue link, the annotation must be LONG — a multi-paragraph explanation covering the failure mode, why it matters, affected code paths, and the recommended fix.",
		),
	annotation_position: z
		.enum(["left", "right"])
		.describe("Which side to display the annotation relative to the code"),
});

const addDiffBlockSchema = z.object({
	file_path: z.string().describe("Path to the changed file"),
	patch: z.string().describe("Unified diff patch text (with @@ hunk headers)"),
	annotation: z
		.string()
		.nullable()
		.describe(
			"Markdown note displayed alongside the diff, or null for no annotation. Keep concise (1-3 sentences) for purely explanatory blocks. If this block will be the target of a flag_issue link, the annotation must be LONG — a multi-paragraph explanation covering the failure mode, why it matters, affected code paths, and the recommended fix.",
		),
	annotation_position: z
		.enum(["left", "right"])
		.describe("Which side to display the annotation relative to the diff"),
});

const flagIssueSchema = z.object({
	severity: z
		.enum(["info", "warning", "critical"])
		.describe(
			"info: minor note; warning: should be addressed before merge; critical: blocks merge or introduces serious risk",
		),
	title: z.string().describe("Short title of the concern (10 words max)"),
	description: z
		.string()
		.describe(
			"MINIMAL one-sentence label for the issues-list card (≤ ~15 words). Do not explain the concern here — the full explanation belongs in the annotation of the linked block (block_orders).",
		),
	block_orders: z
		.array(z.number().int().nonnegative())
		.min(1)
		.describe(
			"Order numbers of the block(s) that explain this concern — reviewers click the issue to jump to the first referenced block. Must reference blocks already added (i.e. < current block count). Provide every block the reviewer should read to understand the issue; at least one is required.",
		),
	file_path: z
		.string()
		.nullable()
		.describe("Path to the relevant file, or null if PR-wide"),
	start_line: z.number().int().nullable().describe("Starting line number of the concern, or null"),
	end_line: z.number().int().nullable().describe("Ending line number of the concern, or null"),
	comment: z
		.string()
		.nullable()
		.describe(
			"Optional inline review comment body to create at this location. Write as GitHub-flavored markdown. The comment will be anchored to comment_line (or end_line if omitted). Only provide when you have a concrete, actionable comment to leave — not every issue needs one.",
		),
	comment_line: z
		.number()
		.int()
		.nullable()
		.describe(
			"Line number within the file to anchor the comment to. Must be within start_line..end_line. Defaults to end_line if null.",
		),
});

const rateAxisSchema = z.object({
	axis: z
		.enum([
			"correctness",
			"scope",
			"tests",
			"clarity",
			"safety",
			"consistency",
			"api_changes",
			"performance",
			"description",
		])
		.describe(
			"Which scorecard axis this rating is for. correctness: logic errors, off-by-ones, race conditions, unhandled errors. scope: is the PR doing one thing, or has it absorbed drive-by refactors / unrelated formatting. tests: new behavior has tests, no suspiciously deleted/weakened assertions. clarity: naming, function length, nesting depth, comment quality, dead code, magic numbers. safety: touches auth, payments, migrations, deletes, public APIs, shared packages (a risk-surface signal, not a quality score). consistency: follows existing codebase patterns (layering, module boundaries, conventions). api_changes: breaking changes to routes, schemas, event payloads, exported types. performance: N+1 queries, unbounded loops, sync work in hot paths, missing indexes. description: does the PR explain why (not just what), link issues, call out deployment concerns.",
		),
	verdict: z
		.enum(["pass", "concern", "blocker"])
		.describe(
			"pass: no meaningful concern on this axis (or n/a for this PR). concern: should be addressed before merge. blocker: do not merge until fixed.",
		),
	confidence: z
		.enum(["low", "medium", "high"])
		.describe(
			"How confident you are in this verdict. Use low when you couldn't find the caller / adjacent tests / relevant config — honest low confidence is more useful than a confident wrong rating.",
		),
	rationale: z
		.string()
		.describe(
			"1–2 sentences. Required. If the axis doesn't apply (e.g. performance on a docs-only PR), emit verdict=pass with a rationale starting 'n/a for this PR — '.",
		),
	details: z
		.string()
		.describe(
			"Rich GitHub-flavored markdown expanding on the rationale. USE THE FULL TOOLKIT: **bold** key terms, `inline code` for identifiers/paths, bullet lists for multiple findings, and ### subheadings if needed. For pass: 2–4 sentences explaining what was checked and why it's clean. For concern/blocker: explain the problem clearly, why it matters, affected code paths, and the recommended fix. Minimum 3 sentences. Do not repeat the rationale verbatim — go deeper.",
		),
	citations: z
		.array(
			z.object({
				file_path: z.string().describe("Path to the cited file"),
				start_line: z.number().int().describe("Starting line number"),
				end_line: z.number().int().describe("Ending line number"),
				note: z
					.string()
					.nullable()
					.describe("Optional short note about what to look at at this location"),
			}),
		)
		.describe(
			"Specific lines backing the verdict. REQUIRED (>= 1) for verdict=concern or verdict=blocker. Optional (may be empty) for verdict=pass.",
		),
	block_orders: z
		.array(z.number().int().nonnegative())
		.describe(
			"Order numbers of walkthrough block(s) that explain this rating in depth — reviewers click through from the rating card to these blocks. May be empty (e.g. for an uneventful pass). Each entry must reference a block already added (< current block count).",
		),
});

const completeWalkthroughSchema = z.object({});

// ── Exported TOOL_SPECS array ─────────────────────────────────────────────────

// Using a tuple-of-unknowns workaround because each spec has a different ZodObject shape.
// Callers that need type safety access individual specs from the array.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOL_SPECS: Array<ToolSpec<any>> = [
	// ── set_walkthrough_summary ──────────────────────────────────────────
	{
		name: "set_walkthrough_summary",
		description:
			"Set the PR summary and risk level. Must be called exactly once, before any other walkthrough tools.",
		inputSchema: setSummarySchema,
		handler: async (
			args: z.infer<typeof setSummarySchema>,
			state: WalkthroughToolState,
			emit: (event: WalkthroughStreamEvent) => void,
		) => {
			if (state.summarySet) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: summary already set. You can only call set_walkthrough_summary once.",
						},
					],
					isError: true,
				};
			}
			state.summarySet = true;
			emit({
				type: "summary",
				data: {
					summary: args.summary,
					riskLevel: args.risk_level as RiskLevel,
				},
			});
			return {
				content: [
					{
						type: "text" as const,
						text: "Summary set successfully. Now add walkthrough blocks.",
					},
				],
			};
		},
	},

	// ── add_markdown_section ─────────────────────────────────────────────
	{
		name: "add_markdown_section",
		description:
			"Add a RICHLY FORMATTED markdown section to the walkthrough. This is the narrative spine of the document — use real markdown, not flat plain text.",
		inputSchema: addMarkdownSchema,
		handler: async (
			args: z.infer<typeof addMarkdownSchema>,
			state: WalkthroughToolState,
			emit: (event: WalkthroughStreamEvent) => void,
		) => {
			if (!state.summarySet) {
				return {
					content: [{ type: "text" as const, text: "Error: call set_walkthrough_summary first." }],
					isError: true,
				};
			}
			if (state.completed) {
				return {
					content: [{ type: "text" as const, text: "Error: walkthrough already completed." }],
					isError: true,
				};
			}
			if (!state.writingPhaseEmitted) {
				state.writingPhaseEmitted = true;
				emit({
					type: "phase",
					data: { phase: "writing", message: "Building walkthrough..." },
				});
			}
			const block: MarkdownBlock = {
				type: "markdown",
				id: `block-${state.blockCount}`,
				order: state.blockCount,
				content: args.content,
			};
			state.blockCount++;
			emit({ type: "block", data: block });
			return {
				content: [
					{
						type: "text" as const,
						text: `Markdown section added (block ${block.order}).`,
					},
				],
			};
		},
	},

	// ── add_code_block ───────────────────────────────────────────────────
	{
		name: "add_code_block",
		description:
			"Add an annotated code block showing source code from a specific file. Use to highlight important code the reviewer should see.",
		inputSchema: addCodeBlockSchema,
		handler: async (
			args: z.infer<typeof addCodeBlockSchema>,
			state: WalkthroughToolState,
			emit: (event: WalkthroughStreamEvent) => void,
		) => {
			if (!state.summarySet) {
				return {
					content: [{ type: "text" as const, text: "Error: call set_walkthrough_summary first." }],
					isError: true,
				};
			}
			if (state.completed) {
				return {
					content: [{ type: "text" as const, text: "Error: walkthrough already completed." }],
					isError: true,
				};
			}
			if (!state.writingPhaseEmitted) {
				state.writingPhaseEmitted = true;
				emit({
					type: "phase",
					data: { phase: "writing", message: "Building walkthrough..." },
				});
			}
			const block: CodeBlock = {
				type: "code",
				id: `block-${state.blockCount}`,
				order: state.blockCount,
				filePath: args.file_path,
				startLine: args.start_line,
				endLine: args.end_line,
				language: args.language,
				content: args.content,
				annotation: args.annotation,
				annotationPosition: args.annotation_position,
			};
			state.blockCount++;
			emit({ type: "block", data: block });
			return {
				content: [
					{
						type: "text" as const,
						text: `Code block added: ${args.file_path}:${args.start_line}-${args.end_line} (block ${block.order}).`,
					},
				],
			};
		},
	},

	// ── add_diff_block ───────────────────────────────────────────────────
	{
		name: "add_diff_block",
		description:
			"Add an annotated diff block showing changes in unified diff format. Use to highlight specific changes the reviewer should focus on.",
		inputSchema: addDiffBlockSchema,
		handler: async (
			args: z.infer<typeof addDiffBlockSchema>,
			state: WalkthroughToolState,
			emit: (event: WalkthroughStreamEvent) => void,
		) => {
			if (!state.summarySet) {
				return {
					content: [{ type: "text" as const, text: "Error: call set_walkthrough_summary first." }],
					isError: true,
				};
			}
			if (state.completed) {
				return {
					content: [{ type: "text" as const, text: "Error: walkthrough already completed." }],
					isError: true,
				};
			}
			if (!state.writingPhaseEmitted) {
				state.writingPhaseEmitted = true;
				emit({
					type: "phase",
					data: { phase: "writing", message: "Building walkthrough..." },
				});
			}
			const block: DiffBlock = {
				type: "diff",
				id: `block-${state.blockCount}`,
				order: state.blockCount,
				filePath: args.file_path,
				patch: args.patch,
				annotation: args.annotation,
				annotationPosition: args.annotation_position,
			};
			state.blockCount++;
			emit({ type: "block", data: block });
			return {
				content: [
					{
						type: "text" as const,
						text: `Diff block added: ${args.file_path} (block ${block.order}).`,
					},
				],
			};
		},
	},

	// ── flag_issue ───────────────────────────────────────────────────────
	{
		name: "flag_issue",
		description:
			"Flag a structured concern or issue found in the PR. Call this for every concern you identify — security vulnerabilities, race conditions, missing tests, edge cases, breaking changes, etc. Must be called AFTER the block(s) that explain the concern have been added, and must link to them via block_orders.",
		inputSchema: flagIssueSchema,
		handler: async (
			args: z.infer<typeof flagIssueSchema>,
			state: WalkthroughToolState,
			emit: (event: WalkthroughStreamEvent) => void,
		) => {
			if (!state.summarySet) {
				return {
					content: [{ type: "text" as const, text: "Error: call set_walkthrough_summary first." }],
					isError: true,
				};
			}
			if (state.completed) {
				return {
					content: [{ type: "text" as const, text: "Error: walkthrough already completed." }],
					isError: true,
				};
			}
			const maxOrder = state.blockCount - 1;
			const invalid = args.block_orders.filter((o: number) => o > maxOrder);
			if (invalid.length > 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: block_orders [${invalid.join(", ")}] reference blocks that haven't been added yet (current block count: ${state.blockCount}). Add the explaining block(s) first with add_markdown_section / add_code_block / add_diff_block, then call flag_issue.`,
						},
					],
					isError: true,
				};
			}
			const uniqueOrders = Array.from(new Set(args.block_orders));
			const blockIds = uniqueOrders.map((o: number) => `block-${o}`);
			const issue: WalkthroughIssue = {
				id: `issue-${state.issueCount}`,
				severity: args.severity,
				title: args.title,
				description: args.description,
				blockIds,
				...(args.file_path !== null ? { filePath: args.file_path } : {}),
				...(args.start_line !== null ? { startLine: args.start_line } : {}),
				...(args.end_line !== null ? { endLine: args.end_line } : {}),
				// pass comment fields through to the stream event
				...(args.comment !== null && args.comment !== undefined ? { comment: args.comment } : {}),
				...(args.comment_line !== null && args.comment_line !== undefined ? { commentLine: args.comment_line } : {}),
			};
			state.issueCount++;
			emit({ type: "issue", data: issue });
			return {
				content: [
					{
						type: "text" as const,
						text: `Issue flagged: [${issue.severity}] ${issue.title} (linked to ${blockIds.join(", ")})${issue.comment ? ' [comment queued]' : ''}`,
					},
				],
			};
		},
	},

	// ── rate_axis ─────────────────────────────────────────────────────────
	{
		name: "rate_axis",
		description:
			"Rate the PR on a single scorecard axis. Must be called exactly once for EACH of the 9 axes before complete_walkthrough. Use the asymmetric 3-level scale (pass/concern/blocker) — LLMs calibrate poorly on 1–10 numeric scales, and reviewers care about outliers, not fine-grained scores. Non-pass verdicts MUST cite specific file:line ranges so the reviewer can jump straight to the evidence.",
		inputSchema: rateAxisSchema,
		handler: async (
			args: z.infer<typeof rateAxisSchema>,
			state: WalkthroughToolState,
			emit: (event: WalkthroughStreamEvent) => void,
		) => {
			if (!state.summarySet) {
				return {
					content: [{ type: "text" as const, text: "Error: call set_walkthrough_summary first." }],
					isError: true,
				};
			}
			if (state.completed) {
				return {
					content: [{ type: "text" as const, text: "Error: walkthrough already completed." }],
					isError: true,
				};
			}
			if (state.ratedAxes.has(args.axis)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: axis '${args.axis}' has already been rated. Each axis is rated exactly once per walkthrough.`,
						},
					],
					isError: true,
				};
			}
			if (args.verdict !== "pass" && args.citations.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: verdict='${args.verdict}' requires at least one citation. Add a citation pointing to the specific line range that prompted the verdict, or downgrade to 'pass' with an explanatory rationale.`,
						},
					],
					isError: true,
				};
			}
			const maxOrder = state.blockCount - 1;
			const invalid = args.block_orders.filter((o: number) => o > maxOrder);
			if (invalid.length > 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: block_orders [${invalid.join(", ")}] reference blocks that haven't been added yet (current block count: ${state.blockCount}). Add the explaining block(s) first, then call rate_axis.`,
						},
					],
					isError: true,
				};
			}

			const uniqueOrders = Array.from(new Set(args.block_orders));
			const blockIds = uniqueOrders.map((o: number) => `block-${o}`);
			const citations: RatingCitation[] = args.citations.map(
				(c: { file_path: string; start_line: number; end_line: number; note: string | null }) => ({
					filePath: c.file_path,
					startLine: c.start_line,
					endLine: c.end_line,
					...(c.note !== null ? { note: c.note } : {}),
				}),
			);
			const rating: WalkthroughRating = {
				axis: args.axis,
				verdict: args.verdict,
				confidence: args.confidence,
				rationale: args.rationale,
				details: args.details,
				citations,
				blockIds,
			};
			state.ratedAxes.add(args.axis);
			emit({ type: "rating", data: rating });
			return {
				content: [
					{
						type: "text" as const,
						text: `Rated ${args.axis}: ${args.verdict} (${args.confidence} confidence). ${state.ratedAxes.size}/${RATING_AXES.length} axes rated.`,
					},
				],
			};
		},
	},

	// ── complete_walkthrough ─────────────────────────────────────────────
	{
		name: "complete_walkthrough",
		description:
			"Signal that the walkthrough is complete. Call this once after all sections, blocks, flagged issues, and all 9 rate_axis calls have been made.",
		inputSchema: completeWalkthroughSchema,
		handler: async (
			_args: z.infer<typeof completeWalkthroughSchema>,
			state: WalkthroughToolState,
			emit: (event: WalkthroughStreamEvent) => void,
		) => {
			if (state.completed) {
				return {
					content: [{ type: "text" as const, text: "Error: walkthrough already completed." }],
					isError: true,
				};
			}
			const missing = RATING_AXES.filter((axis) => !state.ratedAxes.has(axis));
			if (missing.length > 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: missing ratings for [${missing.join(", ")}]. Call rate_axis for each before complete_walkthrough. Every PR must score on all 9 axes — use verdict=pass with a rationale starting 'n/a for this PR — ' for axes that don't apply.`,
						},
					],
					isError: true,
				};
			}
			state.completed = true;
			emit({
				type: "done",
				data: {
					walkthroughId: "",
					tokenUsage: {
						inputTokens: 0,
						outputTokens: 0,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
					},
				},
			});
			return {
				content: [{ type: "text" as const, text: "Walkthrough complete." }],
			};
		},
	},
];
