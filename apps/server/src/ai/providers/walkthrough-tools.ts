// ─── walkthrough-tools ───────────────────────────────────────────────────────
//
// Phase-bound MCP tool handlers for the walkthrough pipeline. Consumed by both
// the Claude Agent SDK (in-process via mcp-walkthrough.ts) and the HTTP MCP
// route (apps/server/src/routes/mcp/walkthrough.ts). Handler implementations
// are shared — per doctrine invariant #13 (Agent-path parity), behavior is
// byte-for-byte identical across transports.
//
// Each handler:
//   1. Opens a single db.transaction() covering: phase read, precondition
//      check, content upsert, phase advance.
//   2. Emits a WalkthroughStreamEvent AFTER the DB commit (commit-first /
//      broadcast-second — doctrine invariant #8).
//   3. Returns an MCP-style `{ content, isError? }` result.
//
// Phase preconditions are enforced here AND only here. If a caller invokes
// add_diff_step before set_overview, this module returns a structured error
// the agent can recover from — the DB row is never touched.

import { and, eq, inArray } from "drizzle-orm";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type {
	CodeBlock,
	CommentThread,
	DiffBlock,
	MarkdownBlock,
	RatingAxis,
	RatingCitation,
	RiskLevel,
	ThreadMessage,
	WalkthroughBlock,
	WalkthroughIssue,
	WalkthroughPipelinePhase,
	WalkthroughRating,
	WalkthroughState,
	WalkthroughStreamEvent,
} from "@revv/shared";
import { RATING_AXES } from "@revv/shared";
import type { Db } from "../../db";
import { commentThreads } from "../../db/schema/comment-threads";
import { threadMessages } from "../../db/schema/thread-messages";
import { walkthroughs } from "../../db/schema/walkthroughs";
import { walkthroughBlocks } from "../../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import { walkthroughRatings } from "../../db/schema/walkthrough-ratings";
import {
	RATING_AXES as RATING_AXES_SPEC,
	addDiffStepSchema,
	addIssueCommentSchema,
	completeWalkthroughSchema,
	computeAnchorThreadId,
	computeIssueId,
	flagIssueSchema,
	getWalkthroughStateSchema,
	rateAxisSchema,
	setOverviewSchema,
	setSentimentSchema,
	type AddDiffStepInput,
	type AddIssueCommentInput,
	type CompleteWalkthroughInput,
	type FlagIssueInput,
	type GetWalkthroughStateInput,
	type RateAxisInput,
	type SetOverviewInput,
	type SetSentimentInput,
	type ToolSpec,
	type WalkthroughToolContext,
	type WalkthroughToolHandler,
	type WalkthroughToolResult,
} from "./walkthrough-tool-spec";

// ── Phase helpers ────────────────────────────────────────────────────────────

const PHASE_ORDER: Record<WalkthroughPipelinePhase, number> = {
	none: 0,
	A: 1,
	B: 2,
	C: 3,
	D: 4,
};

function phaseAtLeast(
	phase: WalkthroughPipelinePhase,
	min: WalkthroughPipelinePhase,
): boolean {
	return PHASE_ORDER[phase] >= PHASE_ORDER[min];
}

function phaseAtMost(
	phase: WalkthroughPipelinePhase,
	max: WalkthroughPipelinePhase,
): boolean {
	return PHASE_ORDER[phase] <= PHASE_ORDER[max];
}

function errorResult(text: string): WalkthroughToolResult {
	return { content: [{ type: "text" as const, text }], isError: true };
}

function okResult(text: string): WalkthroughToolResult {
	return { content: [{ type: "text" as const, text }] };
}

/**
 * Read the walkthrough row for a tool call. Throws a tool-level error result
 * if the row is missing — the orchestrator is supposed to have created the
 * row before the agent starts calling tools.
 */
function loadWalkthroughRow(
	db: Db,
	walkthroughId: string,
): typeof walkthroughs.$inferSelect | null {
	return (
		db
			.select()
			.from(walkthroughs)
			.where(eq(walkthroughs.id, walkthroughId))
			.get() ?? null
	);
}

// ── Comment-pairing validation ───────────────────────────────────────────────
//
// Single source of truth for the "warning/critical line-anchored issues must
// have ≥1 inline comment" rule (doctrine invariant #12). Both
// `complete_walkthrough` (tool-surface gate) and `WalkthroughJobs`
// (orchestrator gate before transitioning `status='complete'`) call this.
// They MUST stay in lockstep — otherwise the agent can finish at phase=D
// with no comments and the orchestrator silently marks the walkthrough
// `complete`.

export interface MissingInlineComment {
	id: string;
	severity: "warning" | "critical";
	title: string;
	filePath: string;
	startLine: number;
}

/**
 * Returns the list of warning/critical, line-anchored issues that have no
 * inline comment thread yet. Empty array means the comment-pairing
 * invariant holds — `complete_walkthrough` may proceed and the orchestrator
 * may transition `status` to `'complete'`.
 *
 * Exempt by design (returned as "satisfied"):
 *   - severity = 'info'           (nitpicks; reviewers want a clean panel)
 *   - filePath / startLine = null (PR-wide concerns; no anchor possible)
 */
export function findIssuesMissingInlineComment(
	db: Db,
	walkthroughId: string,
): MissingInlineComment[] {
	const requiresCommentIssues = db
		.select({
			id: walkthroughIssues.id,
			title: walkthroughIssues.title,
			severity: walkthroughIssues.severity,
			filePath: walkthroughIssues.filePath,
			startLine: walkthroughIssues.startLine,
		})
		.from(walkthroughIssues)
		.where(eq(walkthroughIssues.walkthroughId, walkthroughId))
		.all()
		.filter(
			(
				i,
			): i is typeof i & {
				filePath: string;
				startLine: number;
				severity: "warning" | "critical";
			} =>
				i.filePath !== null &&
				i.startLine !== null &&
				(i.severity === "warning" || i.severity === "critical"),
		);

	if (requiresCommentIssues.length === 0) return [];

	const issueIds = requiresCommentIssues.map((i) => i.id);
	const commentedRows = db
		.select({ walkthroughIssueId: commentThreads.walkthroughIssueId })
		.from(commentThreads)
		.where(inArray(commentThreads.walkthroughIssueId, issueIds))
		.all();
	const commentedSet = new Set(
		commentedRows
			.map((r) => r.walkthroughIssueId)
			.filter((v): v is string => v !== null),
	);
	return requiresCommentIssues
		.filter((i) => !commentedSet.has(i.id))
		.map((i) => ({
			id: i.id,
			severity: i.severity,
			title: i.title,
			filePath: i.filePath,
			startLine: i.startLine,
		}));
}

/**
 * Renders the canonical error message for a missing-inline-comment list.
 * Used by both `complete_walkthrough` (returned to the agent) and the
 * orchestrator (for log messages on the auto-continuation path). Keeping
 * the format unified means the agent sees the same wording whether the
 * gate trips at the tool surface or surfaces via `get_walkthrough_state`
 * on a resumed run.
 */
export function renderMissingInlineCommentError(
	uncommented: MissingInlineComment[],
): string {
	const list = uncommented
		.map(
			(i) =>
				`  - id=${i.id} [${i.severity}] (${i.filePath}:${i.startLine}) "${i.title}"`,
		)
		.join("\n");
	return `Error: ${uncommented.length} flagged issue(s) at severity 'warning' or 'critical' have no inline comment. For each, you MUST also call add_issue_comment with the matching issue_id. Missing:\n${list}\n\nCall add_issue_comment for each, then retry complete_walkthrough. (Severity 'info' issues do not require an inline comment.)`;
}

// ── Handler: get_walkthrough_state ───────────────────────────────────────────
//
// The first call every agent run makes, including resumes. Returns enough
// state for the agent to figure out where to pick up: which phase is
// complete, which diff steps exist, which axes have been rated.

export const getWalkthroughStateHandler: WalkthroughToolHandler<
	GetWalkthroughStateInput
> = async (ctx) => {
	const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
	if (!row) {
		return errorResult(
			`Walkthrough ${ctx.walkthroughId} not found. The orchestrator should have created it before the agent ran — check WalkthroughJobs.`,
		);
	}

	const diffBlocks = ctx.db
		.select({
			stepIndex: walkthroughBlocks.stepIndex,
			type: walkthroughBlocks.type,
		})
		.from(walkthroughBlocks)
		.where(
			and(
				eq(walkthroughBlocks.walkthroughId, ctx.walkthroughId),
				eq(walkthroughBlocks.phase, "diff_analysis"),
			),
		)
		.all();

	const ratingRows = ctx.db
		.select({ axis: walkthroughRatings.axis })
		.from(walkthroughRatings)
		.where(eq(walkthroughRatings.walkthroughId, ctx.walkthroughId))
		.all();

	const issueRows = ctx.db
		.select({
			id: walkthroughIssues.id,
			order: walkthroughIssues.order,
			title: walkthroughIssues.title,
			filePath: walkthroughIssues.filePath,
			startLine: walkthroughIssues.startLine,
			endLine: walkthroughIssues.endLine,
		})
		.from(walkthroughIssues)
		.where(eq(walkthroughIssues.walkthroughId, ctx.walkthroughId))
		.all();

	const diffSteps = diffBlocks
		.filter((b): b is { stepIndex: number; type: string } => b.stepIndex !== null)
		.sort((a, b) => a.stepIndex - b.stepIndex)
		.map((b) => ({
			stepIndex: b.stepIndex,
			blockType: b.type as WalkthroughBlock["type"],
		}));

	const issues = issueRows
		.slice()
		.sort((a, b) => a.order - b.order)
		.map((r) => ({
			id: r.id,
			title: r.title,
			filePath: r.filePath,
			startLine: r.startLine,
			endLine: r.endLine,
		}));

	// Surface unfinished comment-pairing work so resumes (and any agent that
	// is reasoning about whether it can call `complete_walkthrough` yet)
	// don't have to deduce it from the issues list. This is the same query
	// the orchestrator and `complete_walkthrough` use — single source of
	// truth (see findIssuesMissingInlineComment).
	const issuesNeedingInlineComment = findIssuesMissingInlineComment(
		ctx.db,
		ctx.walkthroughId,
	);

	const state: WalkthroughState = {
		walkthroughId: row.id,
		prHeadSha: row.prHeadSha,
		status: row.status as WalkthroughState["status"],
		lastCompletedPhase:
			row.lastCompletedPhase as WalkthroughPipelinePhase,
		summary: row.summary || null,
		riskLevel: row.summary ? (row.riskLevel as RiskLevel) : null,
		sentiment: row.sentiment ?? null,
		diffSteps,
		ratedAxes: ratingRows.map((r) => r.axis as RatingAxis),
		issues,
		issueCount: issues.length,
		issuesNeedingInlineComment,
	};

	// Loud, plain-text banner when the agent has unfinished comment work.
	// The JSON state still contains the full list, but the prefix makes it
	// impossible for the model to skim past — especially on resume, where
	// missing this would lead straight back to the same complete_walkthrough
	// validation failure.
	const stateJson = JSON.stringify(state);
	const text =
		issuesNeedingInlineComment.length > 0
			? `WARNING: ${issuesNeedingInlineComment.length} line-anchored issue(s) at severity 'warning' or 'critical' have no inline comment yet — call add_issue_comment for each before complete_walkthrough.\n\n${stateJson}`
			: stateJson;

	return {
		content: [{ type: "text" as const, text }],
	};
};

// ── Handler: set_overview (Phase A) ──────────────────────────────────────────
//
// Phase precondition: last_completed_phase === 'none'.
// Writes: walkthroughs.summary, walkthroughs.risk_level.
// Advances: last_completed_phase → 'A'.

export const setOverviewHandler: WalkthroughToolHandler<SetOverviewInput> =
	async (ctx, input) => {
		let result: WalkthroughToolResult | null = null;
		ctx.db.transaction(() => {
			const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
			if (!row) {
				result = errorResult(
					`Walkthrough ${ctx.walkthroughId} not found.`,
				);
				return;
			}
			const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
			if (phase !== "none") {
				result = errorResult(
					`Error: set_overview can only be called once, before any other tool. Current phase: '${phase}'. If you're resuming, call get_walkthrough_state first — the overview has already been set.`,
				);
				return;
			}
			ctx.db
				.update(walkthroughs)
				.set({
					summary: input.summary,
					riskLevel: input.risk_level,
					lastCompletedPhase: "A",
				})
				.where(eq(walkthroughs.id, ctx.walkthroughId))
				.run();
		});
		if (result) return result;

		ctx.emit({
			type: "summary",
			data: {
				summary: input.summary,
				riskLevel: input.risk_level as RiskLevel,
			},
		});
		ctx.emit({
			type: "phase:advanced",
			data: { lastCompletedPhase: "A" },
		});
		return okResult(
			"Overview set. Phase A complete — now add diff-analysis steps with add_diff_step (one call per step).",
		);
	};

// ── Handler: add_diff_step (Phase B) ─────────────────────────────────────────
//
// Phase precondition: last_completed_phase ∈ {'A', 'B'}.
// Writes: one walkthrough_blocks row (upsert on (walkthroughId, phase,
// stepIndex)).
// Advances: last_completed_phase → 'B' (first step only).

function blockVariantCount(input: AddDiffStepInput): number {
	let n = 0;
	if (input.markdown != null) n++;
	if (input.code != null) n++;
	if (input.diff != null) n++;
	return n;
}

export const addDiffStepHandler: WalkthroughToolHandler<AddDiffStepInput> =
	async (ctx, input) => {
		// Exactly one of {markdown, code, diff} must be provided.
		if (blockVariantCount(input) !== 1) {
			return errorResult(
				"Error: add_diff_step requires exactly one of { markdown, code, diff } — not zero, not two. Pick the shape that matches the step's intent.",
			);
		}

		let result: WalkthroughToolResult | null = null;
		let block: WalkthroughBlock | null = null;
		let isFirstStep = false;
		ctx.db.transaction(() => {
			const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
			if (!row) {
				result = errorResult(
					`Walkthrough ${ctx.walkthroughId} not found.`,
				);
				return;
			}
			const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
			if (!phaseAtLeast(phase, "A") || !phaseAtMost(phase, "B")) {
				result = errorResult(
					`Error: add_diff_step requires Phase A complete and Phase C not yet entered. Current phase: '${phase}'. Call set_overview first, or stop adding diff steps once sentiment has been set.`,
				);
				return;
			}

			const blockId = `block-${ctx.walkthroughId}-${input.step_index}`;
			const now = new Date().toISOString();

			if (input.markdown) {
				const md: MarkdownBlock = {
					type: "markdown",
					id: blockId,
					order: input.step_index,
					phase: "diff_analysis",
					stepIndex: input.step_index,
					content: input.markdown.content,
				};
				block = md;
				ctx.db
					.insert(walkthroughBlocks)
					.values({
						id: blockId,
						walkthroughId: ctx.walkthroughId,
						phase: "diff_analysis",
						stepIndex: input.step_index,
						order: input.step_index,
						type: "markdown",
						data: JSON.stringify(md),
						createdAt: now,
					})
					.onConflictDoUpdate({
						target: [
							walkthroughBlocks.walkthroughId,
							walkthroughBlocks.phase,
							walkthroughBlocks.stepIndex,
						],
						set: {
							type: "markdown",
							order: input.step_index,
							data: JSON.stringify(md),
						},
					})
					.run();
			} else if (input.code) {
				const code: CodeBlock = {
					type: "code",
					id: blockId,
					order: input.step_index,
					phase: "diff_analysis",
					stepIndex: input.step_index,
					filePath: input.code.file_path,
					startLine: input.code.start_line,
					endLine: input.code.end_line,
					language: input.code.language,
					content: input.code.content,
					annotation: input.code.annotation,
					annotationPosition: input.code.annotation_position,
				};
				block = code;
				ctx.db
					.insert(walkthroughBlocks)
					.values({
						id: blockId,
						walkthroughId: ctx.walkthroughId,
						phase: "diff_analysis",
						stepIndex: input.step_index,
						order: input.step_index,
						type: "code",
						data: JSON.stringify(code),
						createdAt: now,
					})
					.onConflictDoUpdate({
						target: [
							walkthroughBlocks.walkthroughId,
							walkthroughBlocks.phase,
							walkthroughBlocks.stepIndex,
						],
						set: {
							type: "code",
							order: input.step_index,
							data: JSON.stringify(code),
						},
					})
					.run();
			} else if (input.diff) {
				const diff: DiffBlock = {
					type: "diff",
					id: blockId,
					order: input.step_index,
					phase: "diff_analysis",
					stepIndex: input.step_index,
					filePath: input.diff.file_path,
					patch: input.diff.patch,
					annotation: input.diff.annotation,
					annotationPosition: input.diff.annotation_position,
				};
				block = diff;
				ctx.db
					.insert(walkthroughBlocks)
					.values({
						id: blockId,
						walkthroughId: ctx.walkthroughId,
						phase: "diff_analysis",
						stepIndex: input.step_index,
						order: input.step_index,
						type: "diff",
						data: JSON.stringify(diff),
						createdAt: now,
					})
					.onConflictDoUpdate({
						target: [
							walkthroughBlocks.walkthroughId,
							walkthroughBlocks.phase,
							walkthroughBlocks.stepIndex,
						],
						set: {
							type: "diff",
							order: input.step_index,
							data: JSON.stringify(diff),
						},
					})
					.run();
			}

			if (phase === "A") {
				isFirstStep = true;
				ctx.db
					.update(walkthroughs)
					.set({ lastCompletedPhase: "B" })
					.where(eq(walkthroughs.id, ctx.walkthroughId))
					.run();
			}
		});
		if (result) return result;
		if (!block) {
			return errorResult(
				"Internal error: add_diff_step reached emit without a block variant.",
			);
		}

		ctx.emit({ type: "block", data: block });
		if (isFirstStep) {
			ctx.emit({
				type: "phase:advanced",
				data: { lastCompletedPhase: "B" },
			});
		}
		return okResult(
			`Diff step ${input.step_index} persisted. Continue with more steps, or call set_sentiment when Phase B is done.`,
		);
	};

// ── Handler: flag_issue (during Phase B) ─────────────────────────────────────
//
// Phase precondition: last_completed_phase ∈ {'A', 'B'} (issues must link to
// already-persisted diff steps).
// Writes: one walkthrough_issues row (upsert on deterministic id).
// Does not advance phase.

export const flagIssueHandler: WalkthroughToolHandler<FlagIssueInput> = async (
	ctx,
	input,
) => {
	const issueId = await computeIssueId(
		ctx.walkthroughId,
		input.title,
		input.file_path ?? null,
		input.start_line ?? null,
	);

	let result: WalkthroughToolResult | null = null;
	let issueEvent: WalkthroughIssue | null = null;
	ctx.db.transaction(() => {
		const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
		if (!row) {
			result = errorResult(
				`Walkthrough ${ctx.walkthroughId} not found.`,
			);
			return;
		}
		const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
		if (!phaseAtLeast(phase, "A") || !phaseAtMost(phase, "B")) {
			result = errorResult(
				`Error: flag_issue is only valid during Phase A/B. Current phase: '${phase}'.`,
			);
			return;
		}

		// Validate all referenced block_orders point at persisted diff steps.
		const stepRows = ctx.db
			.select({ stepIndex: walkthroughBlocks.stepIndex })
			.from(walkthroughBlocks)
			.where(
				and(
					eq(walkthroughBlocks.walkthroughId, ctx.walkthroughId),
					eq(walkthroughBlocks.phase, "diff_analysis"),
				),
			)
			.all();
		const knownSteps = new Set(
			stepRows
				.map((r) => r.stepIndex)
				.filter((n): n is number => n !== null),
		);
		const unknown = input.block_orders.filter((o) => !knownSteps.has(o));
		if (unknown.length > 0) {
			result = errorResult(
				`Error: block_orders [${unknown.join(", ")}] reference diff steps that don't exist yet. Call add_diff_step for each before flag_issue.`,
			);
			return;
		}

		const uniqueOrders = Array.from(new Set(input.block_orders));
		const blockIds = uniqueOrders.map(
			(o) => `block-${ctx.walkthroughId}-${o}`,
		);

		// Issue `order` is the post-row insertion order within this walkthrough —
		// compute it inside the transaction so concurrent writes (which can't
		// happen today, but defended anyway) don't collide.
		const existing = ctx.db
			.select({ id: walkthroughIssues.id, order: walkthroughIssues.order })
			.from(walkthroughIssues)
			.where(eq(walkthroughIssues.walkthroughId, ctx.walkthroughId))
			.all();
		const order =
			existing.find((e) => e.id === issueId)?.order ?? existing.length;

		const now = new Date().toISOString();
		ctx.db
			.insert(walkthroughIssues)
			.values({
				id: issueId,
				walkthroughId: ctx.walkthroughId,
				order,
				severity: input.severity,
				title: input.title,
				description: input.description,
				filePath: input.file_path ?? null,
				startLine: input.start_line ?? null,
				endLine: input.end_line ?? null,
				blockIds: JSON.stringify(blockIds),
				createdAt: now,
			})
			.onConflictDoUpdate({
				target: walkthroughIssues.id,
				set: {
					severity: input.severity,
					title: input.title,
					description: input.description,
					filePath: input.file_path ?? null,
					startLine: input.start_line ?? null,
					endLine: input.end_line ?? null,
					blockIds: JSON.stringify(blockIds),
				},
			})
			.run();

		const issue: WalkthroughIssue = {
			id: issueId,
			severity: input.severity,
			title: input.title,
			description: input.description,
			blockIds,
			...(input.file_path !== null ? { filePath: input.file_path } : {}),
			...(input.start_line !== null
				? { startLine: input.start_line }
				: {}),
			...(input.end_line !== null ? { endLine: input.end_line } : {}),
		};
		issueEvent = issue;
	});
	if (result) return result;
	if (issueEvent) {
		ctx.emit({ type: "issue", data: issueEvent });
	}
	const hasLineAnchor =
		input.file_path !== null && input.start_line !== null;
	const requiresInlineComment =
		hasLineAnchor &&
		(input.severity === "warning" || input.severity === "critical");
	let nextStepHint: string;
	if (requiresInlineComment) {
		nextStepHint = `\n\nNEXT STEP — REQUIRED: call add_issue_comment with issue_id="${issueId}", file_path="${input.file_path}", start_line=${input.start_line}, end_line=${input.end_line ?? input.start_line}, and a body that explains the concern to the coder (2–6 sentences, markdown, second-person voice). Without that follow-up call this issue has no inline comment in the diff and complete_walkthrough will reject. If the concern affects multiple call-sites, call add_issue_comment once per line range with the same issue_id.`;
	} else if (input.severity === "info") {
		nextStepHint = `\n\n(Severity 'info' — nitpick, no inline comment needed. Continue with the next concern or diff step.)`;
	} else {
		// warning/critical without a line anchor → PR-wide, no anchor possible
		nextStepHint = `\n\n(PR-wide issue with no line anchor — no inline comment needed. Continue with the next concern or diff step.)`;
	}
	return okResult(
		`Issue flagged: [${input.severity}] ${input.title} (id: ${issueId}).${nextStepHint}`,
	);
};

// ── Handler: add_issue_comment (Phase B) ─────────────────────────────────────
//
// Phase precondition: last_completed_phase ∈ {'A', 'B'} (same as flag_issue —
// comments are line-level evidence for issues, both are Phase B artifacts).
// Cross-reference precondition: input.issue_id must point at a walkthrough
// issue belonging to ctx.walkthroughId.
//
// Writes (one transaction): one `comment_threads` row + one `thread_messages`
// row, both keyed on deterministic ids so retries upsert in place. Does NOT
// advance phase. After commit broadcasts a `thread:created` WS event so any
// open `DiffViewerInner` re-renders inline at the anchor.
//
// Idempotency:
//   thread.id   = computeAnchorThreadId(walkthroughId, issueId, file, l1, l2, side)
//   message.id  = `${thread.id}-msg-0`
// A retry with the same anchor replaces the message body in place rather than
// stacking duplicate threads.

export const addIssueCommentHandler: WalkthroughToolHandler<
	AddIssueCommentInput
> = async (ctx, input) => {
	if (input.end_line < input.start_line) {
		return errorResult(
			`Error: end_line (${input.end_line}) is before start_line (${input.start_line}). Use end_line === start_line for a single-line comment.`,
		);
	}

	// Hashing happens before the transaction — sha256 is deterministic and the
	// inputs are already validated, so doing it outside DB scope keeps the
	// transaction tight.
	const threadId = await computeAnchorThreadId(
		ctx.walkthroughId,
		input.issue_id,
		input.file_path,
		input.start_line,
		input.end_line,
		input.diff_side,
	);
	const messageId = `${threadId}-msg-0`;

	let result: WalkthroughToolResult | null = null;
	let createdThread: CommentThread | null = null;
	let createdMessage: ThreadMessage | null = null;
	let sessionId = "";
	ctx.db.transaction(() => {
		const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
		if (!row) {
			result = errorResult(
				`Walkthrough ${ctx.walkthroughId} not found.`,
			);
			return;
		}
		const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
		if (!phaseAtLeast(phase, "A") || !phaseAtMost(phase, "B")) {
			result = errorResult(
				`Error: add_issue_comment is only valid during Phase A/B. Current phase: '${phase}'. Comments are line-level evidence for issues; they belong with the diff analysis, not after sentiment or rating.`,
			);
			return;
		}

		// Cross-reference: the issue must exist for this walkthrough.
		const issueRow = ctx.db
			.select({
				id: walkthroughIssues.id,
				title: walkthroughIssues.title,
			})
			.from(walkthroughIssues)
			.where(
				and(
					eq(walkthroughIssues.id, input.issue_id),
					eq(walkthroughIssues.walkthroughId, ctx.walkthroughId),
				),
			)
			.get();
		if (!issueRow) {
			result = errorResult(
				`Error: issue_id '${input.issue_id}' does not match any flagged issue for this walkthrough. Call flag_issue first; the result text contains the issue id you must pass back here.`,
			);
			return;
		}

		sessionId = row.reviewSessionId;
		const now = new Date().toISOString();

		// Upsert comment_threads row keyed on deterministic threadId.
		// A retry with the same anchor lands here as a no-op (we keep the row
		// untouched — only the message body, below, ever changes on retry).
		ctx.db
			.insert(commentThreads)
			.values({
				id: threadId,
				reviewSessionId: sessionId,
				filePath: input.file_path,
				startLine: input.start_line,
				endLine: input.end_line,
				diffSide: input.diff_side,
				status: "open",
				createdAt: now,
				walkthroughIssueId: input.issue_id,
			})
			.onConflictDoNothing({ target: commentThreads.id })
			.run();

		// Upsert thread_messages row — one message per thread for AI authors.
		// On retry we replace the body and stamp editedAt; the row id is
		// deterministic so we never accumulate duplicates.
		ctx.db
			.insert(threadMessages)
			.values({
				id: messageId,
				threadId,
				authorRole: "ai_agent",
				authorName: "Revv AI",
				authorAvatarUrl: null,
				body: input.body,
				messageType: "comment",
				codeSuggestion: null,
				createdAt: now,
				editedAt: null,
				externalId: null,
			})
			.onConflictDoUpdate({
				target: threadMessages.id,
				set: {
					body: input.body,
					editedAt: now,
				},
			})
			.run();

		// Read back the canonical rows so the broadcast payload reflects what's
		// actually persisted (matches the shape POST /api/reviews/:id/threads
		// emits today).
		const persistedThread = ctx.db
			.select()
			.from(commentThreads)
			.where(eq(commentThreads.id, threadId))
			.get();
		const persistedMessage = ctx.db
			.select()
			.from(threadMessages)
			.where(eq(threadMessages.id, messageId))
			.get();
		if (!persistedThread || !persistedMessage) {
			result = errorResult(
				"Internal error: comment_threads / thread_messages upsert succeeded but read-back returned no row.",
			);
			return;
		}

		createdThread = {
			id: persistedThread.id,
			reviewSessionId: persistedThread.reviewSessionId,
			filePath: persistedThread.filePath,
			startLine: persistedThread.startLine,
			endLine: persistedThread.endLine,
			diffSide: persistedThread.diffSide as CommentThread["diffSide"],
			status: persistedThread.status as CommentThread["status"],
			createdAt: persistedThread.createdAt,
			resolvedAt: persistedThread.resolvedAt ?? null,
			externalThreadId: persistedThread.externalThreadId ?? null,
			externalCommentId: persistedThread.externalCommentId ?? null,
			lastSyncedAt: persistedThread.lastSyncedAt ?? null,
		};
		createdMessage = {
			id: persistedMessage.id,
			threadId: persistedMessage.threadId,
			authorRole: persistedMessage.authorRole as ThreadMessage["authorRole"],
			authorName: persistedMessage.authorName,
			authorAvatarUrl: persistedMessage.authorAvatarUrl ?? null,
			body: persistedMessage.body,
			messageType:
				persistedMessage.messageType as ThreadMessage["messageType"],
			codeSuggestion: persistedMessage.codeSuggestion ?? null,
			createdAt: persistedMessage.createdAt,
			editedAt: persistedMessage.editedAt ?? null,
			externalId: persistedMessage.externalId ?? null,
		};
	});
	if (result) return result;
	if (!createdThread || !createdMessage) {
		return errorResult(
			"Internal error: add_issue_comment reached emit without a persisted thread + message.",
		);
	}

	// Commit-first / broadcast-second (doctrine invariant #8). We always emit
	// thread:created — `DiffViewerInner` dedupes by thread id, so retried
	// upserts are harmless on the UI side.
	ctx.broadcastThreadEvent({
		type: "thread:created",
		data: {
			sessionId,
			thread: createdThread,
			message: createdMessage,
		},
	});

	return okResult(
		`Comment posted on ${input.file_path}:${input.start_line}${
			input.end_line !== input.start_line ? `-${input.end_line}` : ""
		} (${input.diff_side} side) for issue ${input.issue_id}. Thread id: ${threadId}.`,
	);
};

// ── Handler: set_sentiment (Phase C) ─────────────────────────────────────────
//
// Phase precondition: last_completed_phase === 'B' (and thus at least one
// diff step persisted — Phase B can't be entered without one).
// Writes: walkthroughs.sentiment.
// Advances: last_completed_phase → 'C'.

export const setSentimentHandler: WalkthroughToolHandler<SetSentimentInput> =
	async (ctx, input) => {
		let result: WalkthroughToolResult | null = null;
		ctx.db.transaction(() => {
			const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
			if (!row) {
				result = errorResult(
					`Walkthrough ${ctx.walkthroughId} not found.`,
				);
				return;
			}
			const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
			if (phase !== "B") {
				result = errorResult(
					`Error: set_sentiment requires Phase B complete (at least one diff step persisted). Current phase: '${phase}'. Add diff steps first.`,
				);
				return;
			}

			// Defensive: explicit zero-step check even though phase='B' implies ≥1.
			const anyStep = ctx.db
				.select({ id: walkthroughBlocks.id })
				.from(walkthroughBlocks)
				.where(
					and(
						eq(walkthroughBlocks.walkthroughId, ctx.walkthroughId),
						eq(walkthroughBlocks.phase, "diff_analysis"),
					),
				)
				.limit(1)
				.all();
			if (anyStep.length === 0) {
				result = errorResult(
					"Error: set_sentiment requires at least one diff step. Call add_diff_step first.",
				);
				return;
			}

			ctx.db
				.update(walkthroughs)
				.set({ sentiment: input.markdown, lastCompletedPhase: "C" })
				.where(eq(walkthroughs.id, ctx.walkthroughId))
				.run();
		});
		if (result) return result;

		ctx.emit({ type: "sentiment", data: { sentiment: input.markdown } });
		ctx.emit({
			type: "phase:advanced",
			data: { lastCompletedPhase: "C" },
		});
		return okResult(
			"Sentiment set. Phase C complete — now rate each of the 9 axes with rate_axis.",
		);
	};

// ── Handler: rate_axis (Phase D) ─────────────────────────────────────────────
//
// Phase precondition: last_completed_phase ∈ {'C', 'D'}.
// Writes: one walkthrough_ratings row (upsert on (walkthroughId, axis)).
// Advances: last_completed_phase → 'D' on the 9th distinct axis.

export const rateAxisHandler: WalkthroughToolHandler<RateAxisInput> = async (
	ctx,
	input,
) => {
	if (input.verdict !== "pass" && input.citations.length === 0) {
		return errorResult(
			`Error: verdict='${input.verdict}' requires at least one citation. Add a citation pointing to the specific line range, or downgrade to 'pass' with an explanatory rationale.`,
		);
	}

	let result: WalkthroughToolResult | null = null;
	let ratingEvent: WalkthroughRating | null = null;
	let advanced = false;
	ctx.db.transaction(() => {
		const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
		if (!row) {
			result = errorResult(
				`Walkthrough ${ctx.walkthroughId} not found.`,
			);
			return;
		}
		const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
		if (phase !== "C" && phase !== "D") {
			result = errorResult(
				`Error: rate_axis requires Phase C complete (sentiment set). Current phase: '${phase}'. Call set_sentiment first.`,
			);
			return;
		}

		// Validate block_orders reference persisted diff steps if any given.
		if (input.block_orders.length > 0) {
			const stepRows = ctx.db
				.select({ stepIndex: walkthroughBlocks.stepIndex })
				.from(walkthroughBlocks)
				.where(
					and(
						eq(walkthroughBlocks.walkthroughId, ctx.walkthroughId),
						eq(walkthroughBlocks.phase, "diff_analysis"),
					),
				)
				.all();
			const knownSteps = new Set(
				stepRows
					.map((r) => r.stepIndex)
					.filter((n): n is number => n !== null),
			);
			const unknown = input.block_orders.filter(
				(o) => !knownSteps.has(o),
			);
			if (unknown.length > 0) {
				result = errorResult(
					`Error: block_orders [${unknown.join(", ")}] reference diff steps that don't exist.`,
				);
				return;
			}
		}

		const uniqueOrders = Array.from(new Set(input.block_orders));
		const blockIds = uniqueOrders.map(
			(o) => `block-${ctx.walkthroughId}-${o}`,
		);
		const citations: RatingCitation[] = input.citations.map((c) => ({
			filePath: c.file_path,
			startLine: c.start_line,
			endLine: c.end_line,
			...(c.note !== null ? { note: c.note } : {}),
		}));

		const now = new Date().toISOString();
		ctx.db
			.insert(walkthroughRatings)
			.values({
				id: crypto.randomUUID(),
				walkthroughId: ctx.walkthroughId,
				axis: input.axis,
				verdict: input.verdict,
				confidence: input.confidence,
				rationale: input.rationale,
				details: input.details,
				citations: JSON.stringify(citations),
				blockIds: JSON.stringify(blockIds),
				createdAt: now,
			})
			.onConflictDoUpdate({
				target: [
					walkthroughRatings.walkthroughId,
					walkthroughRatings.axis,
				],
				set: {
					verdict: input.verdict,
					confidence: input.confidence,
					rationale: input.rationale,
					details: input.details,
					citations: JSON.stringify(citations),
					blockIds: JSON.stringify(blockIds),
				},
			})
			.run();

		// Count distinct axes rated; advance phase to 'D' if all 9 present.
		const ratedRows = ctx.db
			.select({ axis: walkthroughRatings.axis })
			.from(walkthroughRatings)
			.where(eq(walkthroughRatings.walkthroughId, ctx.walkthroughId))
			.all();
		const ratedSet = new Set(ratedRows.map((r) => r.axis));
		if (
			ratedSet.size === RATING_AXES_SPEC.length &&
			row.lastCompletedPhase !== "D"
		) {
			ctx.db
				.update(walkthroughs)
				.set({ lastCompletedPhase: "D" })
				.where(eq(walkthroughs.id, ctx.walkthroughId))
				.run();
			advanced = true;
		}

		const rating: WalkthroughRating = {
			axis: input.axis,
			verdict: input.verdict,
			confidence: input.confidence,
			rationale: input.rationale,
			details: input.details,
			citations,
			blockIds,
		};
		ratingEvent = rating;
	});
	if (result) return result;
	if (ratingEvent) {
		ctx.emit({ type: "rating", data: ratingEvent });
	}
	if (advanced) {
		ctx.emit({
			type: "phase:advanced",
			data: { lastCompletedPhase: "D" },
		});
	}
	return okResult(
		advanced
			? "Final axis rated — all 9 axes complete. Call complete_walkthrough now."
			: `Axis '${input.axis}' rated. Continue rating the remaining axes.`,
	);
};

// ── Handler: complete_walkthrough (validation gate) ──────────────────────────
//
// Phase precondition: last_completed_phase === 'D' AND all 9 axes rated AND
// sentiment non-empty AND ≥1 diff step. The actual `status='complete'`
// transition is performed by WalkthroughJobs in response to the `done` event —
// this handler only validates, then emits `done`. Doctrine invariant #11:
// status transitions are orchestrator-only.

export const completeWalkthroughHandler: WalkthroughToolHandler<
	CompleteWalkthroughInput
> = async (ctx) => {
	const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
	if (!row) {
		return errorResult(`Walkthrough ${ctx.walkthroughId} not found.`);
	}
	const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
	if (phase !== "D") {
		return errorResult(
			`Error: complete_walkthrough requires Phase D complete (all 9 axes rated). Current phase: '${phase}'.`,
		);
	}
	if (!row.summary || !row.sentiment) {
		return errorResult(
			"Error: complete_walkthrough requires both summary (Phase A) and sentiment (Phase C) to be non-empty.",
		);
	}

	const stepCount = ctx.db
		.select({ id: walkthroughBlocks.id })
		.from(walkthroughBlocks)
		.where(
			and(
				eq(walkthroughBlocks.walkthroughId, ctx.walkthroughId),
				eq(walkthroughBlocks.phase, "diff_analysis"),
			),
		)
		.all().length;
	if (stepCount === 0) {
		return errorResult(
			"Error: complete_walkthrough requires at least one diff step.",
		);
	}

	const ratedAxes = ctx.db
		.select({ axis: walkthroughRatings.axis })
		.from(walkthroughRatings)
		.where(eq(walkthroughRatings.walkthroughId, ctx.walkthroughId))
		.all();
	const ratedSet = new Set(ratedAxes.map((r) => r.axis));
	const missing = RATING_AXES_SPEC.filter((a) => !ratedSet.has(a));
	if (missing.length > 0) {
		return errorResult(
			`Error: missing ratings for [${missing.join(", ")}]. Call rate_axis for each before complete_walkthrough.`,
		);
	}

	// Every line-anchored WARNING or CRITICAL issue must have at least one
	// inline comment. The agent's job is `flag_issue` (sidebar card) +
	// `add_issue_comment` (inline review comment); a warning/critical with no
	// inline comment is invisible to the coder at the place that matters.
	// Exempt: severity='info' (nitpicks — no inline noise expected) and
	// PR-wide issues (file_path / start_line NULL — no anchor possible).
	//
	// Shared with WalkthroughJobs.ts — see findIssuesMissingInlineComment
	// above. Both gates MUST agree, otherwise the orchestrator can mark
	// `complete` while the tool surface would still reject.
	const uncommented = findIssuesMissingInlineComment(
		ctx.db,
		ctx.walkthroughId,
	);
	if (uncommented.length > 0) {
		return errorResult(renderMissingInlineCommentError(uncommented));
	}

	// Deliberately NO stream emit here. The AI provider's generator end
	// (stream-guard synthesizes `done` with real token accounting) is the
	// authoritative completion signal that WalkthroughJobs observes. This
	// tool just validates invariants and lets the agent know it may stop
	// calling tools. Doctrine invariant #11: status transitions are
	// orchestrator-only.
	return okResult(
		"Walkthrough complete. You may stop. The orchestrator will transition status on generator end.",
	);
};

// ── Canonical TOOL_SPECS list ────────────────────────────────────────────────

/**
 * The full phase-bound tool surface. Both the Claude Agent SDK path and the
 * HTTP MCP route (opencode) consume this array — one source of truth.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOL_SPECS: Array<ToolSpec<any>> = [
	{
		name: "get_walkthrough_state",
		description:
			"Read-only. Call FIRST on every run, including resumes. Returns current phase, persisted diff steps, rated axes, and metadata so you can pick up exactly where the previous run stopped. Never calls this are silently tolerated but highly discouraged — you risk duplicating work.",
		inputSchema: getWalkthroughStateSchema,
		handler: getWalkthroughStateHandler,
	},
	{
		name: "set_overview",
		description:
			"Phase A. Call exactly once, before any other write tool. Sets the PR summary (2-3 sentences) and overall risk level (low/medium/high). Advances phase to A.",
		inputSchema: setOverviewSchema,
		handler: setOverviewHandler,
	},
	{
		name: "add_diff_step",
		description:
			"Phase B. Call ONCE PER STEP. Each call persists one narrative unit: markdown, a code excerpt, or a diff hunk (exactly one of the three). step_index is monotonic zero-based and required — retries with the same index are idempotent upserts. Advances phase to B on the first call.",
		inputSchema: addDiffStepSchema,
		handler: addDiffStepHandler,
	},
	{
		name: "flag_issue",
		description:
			"Phase B. Flag a structured concern (security, correctness, tests, perf, etc.). Must be called AFTER the diff step(s) that explain the concern, and must link to them via block_orders (= step_index values).",
		inputSchema: flagIssueSchema,
		handler: flagIssueHandler,
	},
	{
		name: "add_issue_comment",
		description:
			"Phase B. Attach a line-anchored comment to a previously flagged issue — appears inline in the diff view like a human review comment. Call AFTER flag_issue, passing its returned issue id. You may call this multiple times per issue to annotate multiple lines (one tool call per anchor). Idempotent per (issue_id, file_path, start_line, end_line, diff_side): a retry replaces the comment body, never duplicates the thread.",
		inputSchema: addIssueCommentSchema,
		handler: addIssueCommentHandler,
	},
	{
		name: "set_sentiment",
		description:
			"Phase C. Call exactly once, after all diff steps are persisted. 2–4 sentence overall verdict on the PR. Advances phase to C.",
		inputSchema: setSentimentSchema,
		handler: setSentimentHandler,
	},
	{
		name: "rate_axis",
		description:
			"Phase D. Call exactly once for each of the 9 axes (correctness, scope, tests, clarity, safety, consistency, api_changes, performance, description). Idempotent per axis — retries replace the prior rating. The 9th distinct axis advances phase to D.",
		inputSchema: rateAxisSchema,
		handler: rateAxisHandler,
	},
	{
		name: "complete_walkthrough",
		description:
			"Signal that the walkthrough is complete. Fails unless Phase D is reached with all 9 axes rated, summary + sentiment non-empty, and ≥1 diff step. The orchestrator observes the emitted `done` event and performs the final status transition.",
		inputSchema: completeWalkthroughSchema,
		handler: completeWalkthroughHandler,
	},
];

// ── Claude Agent SDK adapter ─────────────────────────────────────────────────
//
// Wraps TOOL_SPECS in the shape the Claude Agent SDK expects. The SDK calls
// tool handlers with just `args`, so we bind the context here (per MCP server
// creation). The HTTP MCP route binds the context per-request instead.

/**
 * Create an MCP server registration for the Claude Agent SDK, scoped to a
 * specific walkthroughId + emitter.
 */
export function createWalkthroughMcpServer(
	ctx: WalkthroughToolContext,
): ReturnType<typeof createSdkMcpServer> {
	return createSdkMcpServer({
		name: "revv-walkthrough",
		version: "2.0.0",
		tools: TOOL_SPECS.map((spec) =>
			tool(
				spec.name,
				spec.description,
				spec.inputSchema.shape,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				async (args: any) => spec.handler(ctx, args),
			),
		),
	});
}

// ── Back-compat shims ────────────────────────────────────────────────────────
//
// The old `WalkthroughEmitter`, `createInitialState`, and
// `WalkthroughToolState` exports are no longer needed — state is in the DB,
// per doctrine. Any caller that still imports those symbols needs to migrate
// to the new context-threading model. We intentionally do NOT re-export the
// old names so stale imports surface as typecheck errors rather than silent
// misbehavior.

export type {
	WalkthroughToolContext,
	WalkthroughToolHandler,
	WalkthroughToolResult,
} from "./walkthrough-tool-spec";
