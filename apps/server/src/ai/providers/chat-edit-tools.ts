// ── chat-edit-tools ─────────────────────────────────────────────────────────
//
// Phase-free MCP tool handlers that let the right-pane chat agent mutate
// the latest completed walkthrough for a PR. The companion read-tool
// `get_walkthrough_for_edit` returns every targeting key (walkthroughId,
// semantic_step_index, step_index, issue_id, axis, thread_message_id) the
// agent needs to write.
//
// Compared to the generation pipeline (walkthrough-tools.ts):
//   - Each handler resolves the target walkthrough lazily — `latest
//     status='complete' walkthrough for ctx.prId` — so a chat that outlives a
//     regenerate naturally targets the freshest row.
//   - No phase preconditions (no A→B→C→D ordering). Edits are an explicit
//     post-completion path (CLAUDE.md invariant #7 chat-edit carve-out).
//   - Each handler stamps `lastEditedAt` / `lastEditedBy` on the parent row
//     inside the same transaction as the content write.
//   - GitHub-submitted issues / comments (`submittedAt != null`) are
//     immutable — every issue/comment edit handler refuses them.
//   - Indices may have gaps. Deletes never renumber siblings.
//   - Emits AFTER commit (doctrine invariant #8). The route wraps the emit
//     callback so events are broadcast as `walkthrough:edited` envelopes
//     via WebSocketHub (not the generation SSE stream).

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type {
	CodeBlock,
	CommentThread,
	DiffBlock,
	MarkdownBlock,
	RatingAxis,
	RatingCitation,
	ThreadMessage,
	WalkthroughBlock,
	WalkthroughIssue,
	WalkthroughRating,
	WalkthroughSemanticStep,
} from "@revv/shared";
import type { Db } from "../../db";
import { commentThreads } from "../../db/schema/comment-threads";
import { threadMessages } from "../../db/schema/thread-messages";
import { walkthroughs } from "../../db/schema/walkthroughs";
import { walkthroughBlocks } from "../../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import { walkthroughRatings } from "../../db/schema/walkthrough-ratings";
import { walkthroughSemanticSteps } from "../../db/schema/walkthrough-semantic-steps";
import {
	blockIdFor,
	findIssuesMissingInlineComment,
	unwrapJsonWrappedString,
} from "./walkthrough-tools";
import { computeAnchorThreadId, computeIssueId } from "./walkthrough-tool-spec";
import {
	addBlockSchema,
	addIssueCommentEditSchema,
	addIssueEditSchema,
	addSemanticStepEditSchema,
	deleteBlockSchema,
	deleteIssueCommentSchema,
	deleteIssueSchema,
	deleteRatingSchema,
	deleteSemanticStepSchema,
	getWalkthroughForEditSchema,
	updateBlockSchema,
	updateIssueCommentSchema,
	updateIssueSchema,
	updateOverviewSchema,
	updateRatingSchema,
	updateSemanticStepSchema,
	updateSentimentSchema,
	type AddBlockInput,
	type AddIssueCommentEditInput,
	type AddIssueEditInput,
	type AddSemanticStepEditInput,
	type BlockContentInput,
	type ChatEditToolHandler,
	type ChatEditToolResult,
	type ChatEditToolSpec,
	type DeleteBlockInput,
	type DeleteIssueCommentInput,
	type DeleteIssueInput,
	type DeleteRatingInput,
	type DeleteSemanticStepInput,
	type GetWalkthroughForEditInput,
	type UpdateBlockInput,
	type UpdateIssueCommentInput,
	type UpdateIssueInput,
	type UpdateOverviewInput,
	type UpdateRatingInput,
	type UpdateSemanticStepInput,
	type UpdateSentimentInput,
} from "./chat-edit-tool-spec";

// ── Result helpers ──────────────────────────────────────────────────────────

function ok(text: string): ChatEditToolResult {
	return { content: [{ type: "text" as const, text }] };
}

function fail(text: string): ChatEditToolResult {
	return { content: [{ type: "text" as const, text }], isError: true };
}

// ── Walkthrough resolution ──────────────────────────────────────────────────

type WalkthroughRow = typeof walkthroughs.$inferSelect;

/**
 * Returns the latest `status='complete'` walkthrough row for the PR, or null
 * if none exists yet. Resolved freshly on every handler call so chat sessions
 * that outlive a regenerate naturally retarget the new walkthrough.
 */
export function resolveActiveWalkthroughId(
	db: Db,
	prId: string,
): WalkthroughRow | null {
	return (
		db
			.select()
			.from(walkthroughs)
			.where(
				and(
					eq(walkthroughs.pullRequestId, prId),
					eq(walkthroughs.status, "complete"),
				),
			)
			.orderBy(desc(walkthroughs.generatedAt))
			.limit(1)
			.get() ?? null
	);
}

/**
 * Inside-transaction guard: re-read the row by id and assert it is still
 * `status='complete'`. Defends against the race where another process
 * supersedes the walkthrough between the outer resolve and our write.
 */
function assertStillComplete(
	db: Db,
	walkthroughId: string,
): { row: WalkthroughRow } | { error: string } {
	const row = db
		.select()
		.from(walkthroughs)
		.where(eq(walkthroughs.id, walkthroughId))
		.get();
	if (!row) {
		return {
			error: `Walkthrough ${walkthroughId} no longer exists. It may have been superseded — call get_walkthrough_for_edit again to retarget.`,
		};
	}
	if (row.status !== "complete") {
		return {
			error: `Walkthrough ${walkthroughId} has status='${row.status}' (expected 'complete'). Edits are only allowed on completed walkthroughs. Call get_walkthrough_for_edit again to retarget.`,
		};
	}
	return { row };
}

function stampLastEdited(
	db: Db,
	walkthroughId: string,
	actor: string,
): void {
	db
		.update(walkthroughs)
		.set({ lastEditedAt: new Date().toISOString(), lastEditedBy: actor })
		.where(eq(walkthroughs.id, walkthroughId))
		.run();
}

// ── Block construction ──────────────────────────────────────────────────────

function blockContentVariantCount(content: BlockContentInput): number {
	let n = 0;
	if (content.markdown != null) n++;
	if (content.code != null) n++;
	if (content.diff != null) n++;
	return n;
}

interface BuiltBlock {
	readonly block: WalkthroughBlock;
	readonly type: "markdown" | "code" | "diff";
	readonly data: string;
}

function buildBlock(
	blockId: string,
	semanticStepIndex: number,
	stepIndex: number,
	content: BlockContentInput,
): BuiltBlock {
	const order = semanticStepIndex * 10000 + stepIndex;
	if (content.markdown) {
		const md: MarkdownBlock = {
			type: "markdown",
			id: blockId,
			order,
			phase: "diff_analysis",
			semanticStepIndex,
			stepIndex,
			content: content.markdown.content,
		};
		return { block: md, type: "markdown", data: JSON.stringify(md) };
	}
	if (content.code) {
		const code: CodeBlock = {
			type: "code",
			id: blockId,
			order,
			phase: "diff_analysis",
			semanticStepIndex,
			stepIndex,
			filePath: content.code.file_path,
			startLine: content.code.start_line,
			endLine: content.code.end_line,
			language: content.code.language,
			content: content.code.content,
			annotation: content.code.annotation,
			annotationPosition: content.code.annotation_position,
		};
		return { block: code, type: "code", data: JSON.stringify(code) };
	}
	if (content.diff) {
		const diff: DiffBlock = {
			type: "diff",
			id: blockId,
			order,
			phase: "diff_analysis",
			semanticStepIndex,
			stepIndex,
			filePath: content.diff.file_path,
			patch: content.diff.patch,
			annotation: content.diff.annotation,
			annotationPosition: content.diff.annotation_position,
		};
		return { block: diff, type: "diff", data: JSON.stringify(diff) };
	}
	throw new Error("buildBlock called with empty content variant");
}

// ── Issue-blockIds JSON helpers ─────────────────────────────────────────────

function parseBlockIds(json: string): string[] {
	try {
		const v = JSON.parse(json) as unknown;
		if (Array.isArray(v))
			return v.filter((x): x is string => typeof x === "string");
	} catch {
		/* corrupt JSON */
	}
	return [];
}

/**
 * For each issue whose `blockIds` JSON contains any of `blockIds`, return the
 * issue row + the surviving blockIds array (after subtraction). Used by
 * delete_block / delete_semantic_step to detect orphans before commit.
 */
function findIssuesReferencingBlocks(
	db: Db,
	walkthroughId: string,
	blockIds: string[],
): Array<{
	row: typeof walkthroughIssues.$inferSelect;
	survivingBlockIds: string[];
}> {
	if (blockIds.length === 0) return [];
	const allIssues = db
		.select()
		.from(walkthroughIssues)
		.where(eq(walkthroughIssues.walkthroughId, walkthroughId))
		.all();
	const removeSet = new Set(blockIds);
	const affected: Array<{
		row: typeof walkthroughIssues.$inferSelect;
		survivingBlockIds: string[];
	}> = [];
	for (const issue of allIssues) {
		const ids = parseBlockIds(issue.blockIds);
		if (!ids.some((id) => removeSet.has(id))) continue;
		const survivors = ids.filter((id) => !removeSet.has(id));
		affected.push({ row: issue, survivingBlockIds: survivors });
	}
	return affected;
}

// ── Rating decode (matches walkthrough-tools.ts payload shape) ──────────────

function decodeRating(
	row: typeof walkthroughRatings.$inferSelect,
): WalkthroughRating {
	const citations: RatingCitation[] = parseCitations(row.citations);
	const blockIds = parseBlockIds(row.blockIds);
	return {
		axis: row.axis as RatingAxis,
		verdict: row.verdict as WalkthroughRating["verdict"],
		confidence: row.confidence as WalkthroughRating["confidence"],
		rationale: row.rationale,
		details: row.details,
		citations,
		blockIds,
	};
}

function parseCitations(json: string): RatingCitation[] {
	try {
		const v = JSON.parse(json) as unknown;
		if (!Array.isArray(v)) return [];
		const out: RatingCitation[] = [];
		for (const c of v) {
			if (c && typeof c === "object") {
				const cc = c as Record<string, unknown>;
				if (
					typeof cc["filePath"] === "string" &&
					typeof cc["startLine"] === "number" &&
					typeof cc["endLine"] === "number"
				) {
					out.push({
						filePath: cc["filePath"],
						startLine: cc["startLine"],
						endLine: cc["endLine"],
						...(typeof cc["note"] === "string" ? { note: cc["note"] } : {}),
					});
				}
			}
		}
		return out;
	} catch {
		return [];
	}
}

function decodeBlock(
	row: typeof walkthroughBlocks.$inferSelect,
): WalkthroughBlock | null {
	try {
		const v = JSON.parse(row.data) as WalkthroughBlock;
		return v;
	} catch {
		return null;
	}
}

function decodeIssue(
	row: typeof walkthroughIssues.$inferSelect,
): WalkthroughIssue {
	const blockIds = parseBlockIds(row.blockIds);
	return {
		id: row.id,
		severity: row.severity as WalkthroughIssue["severity"],
		title: row.title,
		description: row.description,
		blockIds,
		...(row.filePath !== null ? { filePath: row.filePath } : {}),
		...(row.startLine !== null ? { startLine: row.startLine } : {}),
		...(row.endLine !== null ? { endLine: row.endLine } : {}),
		...(row.submittedAt !== null ? { submittedAt: row.submittedAt } : {}),
	};
}

// ── Tool: get_walkthrough_for_edit ──────────────────────────────────────────

const getWalkthroughForEditHandler: ChatEditToolHandler<
	GetWalkthroughForEditInput
> = async (ctx) => {
	const row = resolveActiveWalkthroughId(ctx.db, ctx.prId);
	if (!row) {
		return fail(
			`No complete walkthrough exists for this PR yet. Ask the user to generate one first.`,
		);
	}

	const semanticRows = ctx.db
		.select()
		.from(walkthroughSemanticSteps)
		.where(eq(walkthroughSemanticSteps.walkthroughId, row.id))
		.orderBy(walkthroughSemanticSteps.semanticStepIndex)
		.all();

	const blockRows = ctx.db
		.select()
		.from(walkthroughBlocks)
		.where(eq(walkthroughBlocks.walkthroughId, row.id))
		.orderBy(walkthroughBlocks.semanticStepIndex, walkthroughBlocks.stepIndex)
		.all();

	const issueRows = ctx.db
		.select()
		.from(walkthroughIssues)
		.where(eq(walkthroughIssues.walkthroughId, row.id))
		.orderBy(walkthroughIssues.order)
		.all();

	const ratingRows = ctx.db
		.select()
		.from(walkthroughRatings)
		.where(eq(walkthroughRatings.walkthroughId, row.id))
		.all();

	// Comment threads linked to issues in this walkthrough.
	const issueIds = issueRows.map((i) => i.id);
	const threadRows =
		issueIds.length > 0
			? ctx.db
					.select()
					.from(commentThreads)
					.where(inArray(commentThreads.walkthroughIssueId, issueIds))
					.all()
			: [];
	const threadIds = threadRows.map((t) => t.id);
	const messageRows =
		threadIds.length > 0
			? ctx.db
					.select()
					.from(threadMessages)
					.where(inArray(threadMessages.threadId, threadIds))
					.orderBy(threadMessages.createdAt)
					.all()
			: [];

	const stepIndicesBySection = new Map<number, number[]>();
	for (const b of blockRows) {
		const arr = stepIndicesBySection.get(b.semanticStepIndex) ?? [];
		arr.push(b.stepIndex);
		stepIndicesBySection.set(b.semanticStepIndex, arr);
	}

	const missingComments = findIssuesMissingInlineComment(ctx.db, row.id);
	const ratedAxes = new Set(ratingRows.map((r) => r.axis));
	const requiredAxes = [
		"correctness",
		"scope",
		"tests",
		"clarity",
		"safety",
		"consistency",
		"api_changes",
		"performance",
		"description",
	];
	const missingAxes = requiredAxes.filter((a) => !ratedAxes.has(a));

	const payload = {
		walkthroughId: row.id,
		prHeadSha: row.prHeadSha,
		status: row.status,
		lastCompletedPhase: row.lastCompletedPhase,
		lastEditedAt: row.lastEditedAt,
		lastEditedBy: row.lastEditedBy,
		summary: row.summary,
		riskLevel: row.riskLevel,
		sentiment: row.sentiment,
		semanticSteps: semanticRows.map((s) => ({
			semanticStepIndex: s.semanticStepIndex,
			title: s.title,
			summary: s.summary,
			stepIndices: (stepIndicesBySection.get(s.semanticStepIndex) ?? [])
				.slice()
				.sort((a, b) => a - b),
		})),
		blocks: blockRows
			.map((b) => {
				const decoded = decodeBlock(b);
				return decoded;
			})
			.filter((b): b is WalkthroughBlock => b !== null),
		issues: issueRows.map(decodeIssue),
		ratings: ratingRows.map(decodeRating),
		comments: messageRows.map((m) => {
			const thread = threadRows.find((t) => t.id === m.threadId);
			return {
				threadMessageId: m.id,
				threadId: m.threadId,
				issueId: thread?.walkthroughIssueId ?? null,
				body: m.body,
				filePath: thread?.filePath ?? null,
				startLine: thread?.startLine ?? null,
				endLine: thread?.endLine ?? null,
				diffSide: thread?.diffSide ?? null,
				authorRole: m.authorRole,
				createdAt: m.createdAt,
				editedAt: m.editedAt,
			};
		}),
		validation: {
			passesCompletenessGate:
				missingComments.length === 0 && missingAxes.length === 0,
			missingInlineComments: missingComments.map((m) => ({
				id: m.id,
				severity: m.severity,
				title: m.title,
				filePath: m.filePath,
				startLine: m.startLine,
			})),
			missingAxes,
		},
	};

	return ok(JSON.stringify(payload, null, 2));
};

// ── Tool: update_overview ───────────────────────────────────────────────────

const updateOverviewHandler: ChatEditToolHandler<UpdateOverviewInput> = async (
	ctx,
	input,
) => {
	const summary =
		input.summary != null
			? unwrapJsonWrappedString(input.summary, "summary")
			: null;
	const riskLevel = input.risk_level ?? null;
	if (summary === null && riskLevel === null) {
		return fail(
			"Error: update_overview needs at least one of summary or risk_level. Both were omitted.",
		);
	}

	const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
	if (!active) {
		return fail(
			"No complete walkthrough exists for this PR yet. Ask the user to generate one first.",
		);
	}
	const walkthroughId = active.id;

	let result: ChatEditToolResult | null = null;
	let finalSummary = "";
	let finalRisk: "low" | "medium" | "high" = "low";
	ctx.db.transaction(() => {
		const guarded = assertStillComplete(ctx.db, walkthroughId);
		if ("error" in guarded) {
			result = fail(guarded.error);
			return;
		}
		const patch: { summary?: string; riskLevel?: string } = {};
		if (summary !== null) patch.summary = summary;
		if (riskLevel !== null) patch.riskLevel = riskLevel;
		ctx.db
			.update(walkthroughs)
			.set(patch)
			.where(eq(walkthroughs.id, walkthroughId))
			.run();
		stampLastEdited(ctx.db, walkthroughId, ctx.actor);
		finalSummary = summary ?? guarded.row.summary;
		finalRisk = (riskLevel ?? guarded.row.riskLevel) as
			| "low"
			| "medium"
			| "high";
	});
	if (result) return result;

	ctx.emit(walkthroughId, {
		type: "summary",
		data: { summary: finalSummary, riskLevel: finalRisk },
	});
	return ok(
		`Overview updated. risk=${finalRisk}${summary !== null ? ` summary=${JSON.stringify(finalSummary.slice(0, 80))}…` : ""}.`,
	);
};

// ── Tool: add_semantic_step ─────────────────────────────────────────────────

const addSemanticStepEditHandler: ChatEditToolHandler<
	AddSemanticStepEditInput
> = async (ctx, input) => {
	if (blockContentVariantCount(input.initial_block) !== 1) {
		return fail(
			"Error: add_semantic_step.initial_block requires exactly one of { markdown, code, diff }.",
		);
	}
	const title = input.title.trim();
	if (title.length === 0) {
		return fail("Error: add_semantic_step requires a non-empty title.");
	}

	const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
	if (!active) {
		return fail("No complete walkthrough exists for this PR yet.");
	}
	const walkthroughId = active.id;

	let result: ChatEditToolResult | null = null;
	let emitChapter: WalkthroughSemanticStep | null = null;
	let emitBlock: WalkthroughBlock | null = null;
	ctx.db.transaction(() => {
		const guarded = assertStillComplete(ctx.db, walkthroughId);
		if ("error" in guarded) {
			result = fail(guarded.error);
			return;
		}

		const existing = ctx.db
			.select({ id: walkthroughSemanticSteps.id })
			.from(walkthroughSemanticSteps)
			.where(
				and(
					eq(walkthroughSemanticSteps.walkthroughId, walkthroughId),
					eq(
						walkthroughSemanticSteps.semanticStepIndex,
						input.semantic_step_index,
					),
				),
			)
			.get();
		if (existing) {
			result = fail(
				`Error: a chapter already exists at semantic_step_index=${input.semantic_step_index}. Use update_semantic_step to modify it.`,
			);
			return;
		}

		const now = new Date().toISOString();
		const chapterId = `semantic-${walkthroughId}-${input.semantic_step_index}`;
		ctx.db
			.insert(walkthroughSemanticSteps)
			.values({
				id: chapterId,
				walkthroughId,
				semanticStepIndex: input.semantic_step_index,
				title,
				summary: input.summary ?? null,
				createdAt: now,
			})
			.run();

		const blockId = blockIdFor(walkthroughId, input.semantic_step_index, 0);
		const built = buildBlock(blockId, input.semantic_step_index, 0, {
			...(input.initial_block.markdown != null
				? { markdown: input.initial_block.markdown }
				: {}),
			...(input.initial_block.code != null
				? { code: input.initial_block.code }
				: {}),
			...(input.initial_block.diff != null
				? { diff: input.initial_block.diff }
				: {}),
		});
		ctx.db
			.insert(walkthroughBlocks)
			.values({
				id: blockId,
				walkthroughId,
				phase: "diff_analysis",
				order: input.semantic_step_index * 10000,
				semanticStepIndex: input.semantic_step_index,
				stepIndex: 0,
				type: built.type,
				data: built.data,
				createdAt: now,
			})
			.run();

		stampLastEdited(ctx.db, walkthroughId, ctx.actor);

		emitChapter = {
			semanticStepIndex: input.semantic_step_index,
			title,
			summary: input.summary ?? null,
		};
		emitBlock = built.block;
	});
	if (result) return result;
	if (!emitChapter || !emitBlock) {
		return fail("Internal error: add_semantic_step did not persist correctly.");
	}

	ctx.emit(walkthroughId, { type: "semantic-step", data: emitChapter });
	ctx.emit(walkthroughId, { type: "block", data: emitBlock });
	return ok(
		`Chapter ${input.semantic_step_index} ('${title}') inserted with its first block.`,
	);
};

// ── Tool: update_semantic_step ──────────────────────────────────────────────

const updateSemanticStepHandler: ChatEditToolHandler<
	UpdateSemanticStepInput
> = async (ctx, input) => {
	const hasTitle = typeof input.title === "string" && input.title.length > 0;
	const hasSummary = "summary" in input && input.summary !== undefined;
	if (!hasTitle && !hasSummary) {
		return fail(
			"Error: update_semantic_step needs at least one of title or summary.",
		);
	}

	const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
	if (!active) return fail("No complete walkthrough exists for this PR yet.");
	const walkthroughId = active.id;

	let result: ChatEditToolResult | null = null;
	let emitChapter: WalkthroughSemanticStep | null = null;
	ctx.db.transaction(() => {
		const guarded = assertStillComplete(ctx.db, walkthroughId);
		if ("error" in guarded) {
			result = fail(guarded.error);
			return;
		}

		const existing = ctx.db
			.select()
			.from(walkthroughSemanticSteps)
			.where(
				and(
					eq(walkthroughSemanticSteps.walkthroughId, walkthroughId),
					eq(
						walkthroughSemanticSteps.semanticStepIndex,
						input.semantic_step_index,
					),
				),
			)
			.get();
		if (!existing) {
			result = fail(
				`Error: no chapter exists at semantic_step_index=${input.semantic_step_index}.`,
			);
			return;
		}

		const newTitle = hasTitle ? (input.title as string).trim() : existing.title;
		if (newTitle.length === 0) {
			result = fail("Error: title cannot be empty.");
			return;
		}
		const newSummary = hasSummary
			? (input.summary ?? null)
			: existing.summary;

		ctx.db
			.update(walkthroughSemanticSteps)
			.set({ title: newTitle, summary: newSummary })
			.where(eq(walkthroughSemanticSteps.id, existing.id))
			.run();
		stampLastEdited(ctx.db, walkthroughId, ctx.actor);

		emitChapter = {
			semanticStepIndex: input.semantic_step_index,
			title: newTitle,
			summary: newSummary,
		};
	});
	if (result) return result;
	if (!emitChapter) {
		return fail("Internal error: update_semantic_step did not persist.");
	}

	ctx.emit(walkthroughId, { type: "semantic-step", data: emitChapter });
	return ok(`Chapter ${input.semantic_step_index} updated.`);
};

// ── Tool: delete_semantic_step ──────────────────────────────────────────────

const deleteSemanticStepHandler: ChatEditToolHandler<
	DeleteSemanticStepInput
> = async (ctx, input) => {
	const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
	if (!active) return fail("No complete walkthrough exists for this PR yet.");
	const walkthroughId = active.id;

	let result: ChatEditToolResult | null = null;
	const deletedBlockEvents: Array<{
		id: string;
		semanticStepIndex: number;
		stepIndex: number;
	}> = [];
	const updatedIssueEvents: WalkthroughIssue[] = [];

	ctx.db.transaction(() => {
		const guarded = assertStillComplete(ctx.db, walkthroughId);
		if ("error" in guarded) {
			result = fail(guarded.error);
			return;
		}

		const chapter = ctx.db
			.select()
			.from(walkthroughSemanticSteps)
			.where(
				and(
					eq(walkthroughSemanticSteps.walkthroughId, walkthroughId),
					eq(
						walkthroughSemanticSteps.semanticStepIndex,
						input.semantic_step_index,
					),
				),
			)
			.get();
		if (!chapter) {
			result = fail(
				`Error: no chapter exists at semantic_step_index=${input.semantic_step_index}.`,
			);
			return;
		}

		const chapterBlocks = ctx.db
			.select()
			.from(walkthroughBlocks)
			.where(
				and(
					eq(walkthroughBlocks.walkthroughId, walkthroughId),
					eq(walkthroughBlocks.semanticStepIndex, input.semantic_step_index),
				),
			)
			.all();
		const blockIds = chapterBlocks.map((b) => b.id);

		const affected = findIssuesReferencingBlocks(
			ctx.db,
			walkthroughId,
			blockIds,
		);

		// Pre-validate: refuse if any affected issue has been submitted to
		// GitHub, or if removing these blocks would orphan a warning/critical
		// issue (no remaining blockIds).
		const submitted = affected.filter((a) => a.row.submittedAt !== null);
		if (submitted.length > 0) {
			const titles = submitted.map((a) => `'${a.row.title}'`).join(", ");
			result = fail(
				`Error: cannot delete chapter — ${submitted.length} issue(s) referencing its blocks have been submitted to GitHub (${titles}). Submitted issues are immutable.`,
			);
			return;
		}
		const orphaning = affected.filter(
			(a) =>
				a.survivingBlockIds.length === 0 &&
				(a.row.severity === "warning" || a.row.severity === "critical"),
		);
		if (orphaning.length > 0) {
			const titles = orphaning.map((a) => `'${a.row.title}'`).join(", ");
			result = fail(
				`Error: cannot delete chapter — ${orphaning.length} warning/critical issue(s) reference only blocks inside it (${titles}). Delete those issues first, or move them to other blocks via update_issue.`,
			);
			return;
		}

		// Apply: update each affected issue's blockIds, then delete blocks +
		// chapter.
		for (const a of affected) {
			ctx.db
				.update(walkthroughIssues)
				.set({ blockIds: JSON.stringify(a.survivingBlockIds) })
				.where(eq(walkthroughIssues.id, a.row.id))
				.run();
			const updated = {
				...a.row,
				blockIds: JSON.stringify(a.survivingBlockIds),
			};
			updatedIssueEvents.push(decodeIssue(updated));
		}

		ctx.db
			.delete(walkthroughBlocks)
			.where(
				and(
					eq(walkthroughBlocks.walkthroughId, walkthroughId),
					eq(walkthroughBlocks.semanticStepIndex, input.semantic_step_index),
				),
			)
			.run();
		ctx.db
			.delete(walkthroughSemanticSteps)
			.where(eq(walkthroughSemanticSteps.id, chapter.id))
			.run();

		for (const b of chapterBlocks) {
			deletedBlockEvents.push({
				id: b.id,
				semanticStepIndex: b.semanticStepIndex,
				stepIndex: b.stepIndex,
			});
		}

		stampLastEdited(ctx.db, walkthroughId, ctx.actor);
	});
	if (result) return result;

	for (const ev of deletedBlockEvents)
		ctx.emit(walkthroughId, { type: "block:deleted", data: ev });
	for (const issue of updatedIssueEvents)
		ctx.emit(walkthroughId, { type: "issue", data: issue });
	ctx.emit(walkthroughId, {
		type: "semantic-step:deleted",
		data: { semanticStepIndex: input.semantic_step_index },
	});
	return ok(
		`Chapter ${input.semantic_step_index} deleted (${deletedBlockEvents.length} block(s); ${updatedIssueEvents.length} issue(s) had references scrubbed).`,
	);
};

// ── Tool: add_block ─────────────────────────────────────────────────────────

const addBlockHandler: ChatEditToolHandler<AddBlockInput> = async (
	ctx,
	input,
) => {
	if (blockContentVariantCount(input.content) !== 1) {
		return fail(
			"Error: add_block.content requires exactly one of { markdown, code, diff }.",
		);
	}

	const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
	if (!active) return fail("No complete walkthrough exists for this PR yet.");
	const walkthroughId = active.id;

	let result: ChatEditToolResult | null = null;
	let emitBlock: WalkthroughBlock | null = null;
	let resolvedStepIndex = 0;
	ctx.db.transaction(() => {
		const guarded = assertStillComplete(ctx.db, walkthroughId);
		if ("error" in guarded) {
			result = fail(guarded.error);
			return;
		}

		const parent = ctx.db
			.select({ id: walkthroughSemanticSteps.id })
			.from(walkthroughSemanticSteps)
			.where(
				and(
					eq(walkthroughSemanticSteps.walkthroughId, walkthroughId),
					eq(
						walkthroughSemanticSteps.semanticStepIndex,
						input.semantic_step_index,
					),
				),
			)
			.get();
		if (!parent) {
			result = fail(
				`Error: no chapter exists at semantic_step_index=${input.semantic_step_index}. Call add_semantic_step first.`,
			);
			return;
		}

		// Resolve target step_index. Either explicit (collision-checked) or
		// append (MAX+1).
		let stepIndex: number;
		if (input.step_index != null) {
			const conflict = ctx.db
				.select({ id: walkthroughBlocks.id })
				.from(walkthroughBlocks)
				.where(
					and(
						eq(walkthroughBlocks.walkthroughId, walkthroughId),
						eq(walkthroughBlocks.phase, "diff_analysis"),
						eq(
							walkthroughBlocks.semanticStepIndex,
							input.semantic_step_index,
						),
						eq(walkthroughBlocks.stepIndex, input.step_index),
					),
				)
				.get();
			if (conflict) {
				result = fail(
					`Error: a block already exists at semantic_step_index=${input.semantic_step_index}, step_index=${input.step_index}. Use update_block to modify it, or pick a different step_index.`,
				);
				return;
			}
			stepIndex = input.step_index;
		} else {
			const maxRow = ctx.db
				.select({ max: sql<number | null>`max(${walkthroughBlocks.stepIndex})` })
				.from(walkthroughBlocks)
				.where(
					and(
						eq(walkthroughBlocks.walkthroughId, walkthroughId),
						eq(walkthroughBlocks.phase, "diff_analysis"),
						eq(
							walkthroughBlocks.semanticStepIndex,
							input.semantic_step_index,
						),
					),
				)
				.get();
			const max = maxRow?.max ?? null;
			stepIndex = max === null ? 0 : max + 1;
		}

		const blockId = blockIdFor(walkthroughId, input.semantic_step_index, stepIndex);
		const built = buildBlock(blockId, input.semantic_step_index, stepIndex, {
			...(input.content.markdown != null
				? { markdown: input.content.markdown }
				: {}),
			...(input.content.code != null ? { code: input.content.code } : {}),
			...(input.content.diff != null ? { diff: input.content.diff } : {}),
		});
		const now = new Date().toISOString();
		ctx.db
			.insert(walkthroughBlocks)
			.values({
				id: blockId,
				walkthroughId,
				phase: "diff_analysis",
				order: input.semantic_step_index * 10000 + stepIndex,
				semanticStepIndex: input.semantic_step_index,
				stepIndex,
				type: built.type,
				data: built.data,
				createdAt: now,
			})
			.run();
		stampLastEdited(ctx.db, walkthroughId, ctx.actor);
		emitBlock = built.block;
		resolvedStepIndex = stepIndex;
	});
	if (result) return result;
	if (!emitBlock) return fail("Internal error: add_block did not persist.");

	ctx.emit(walkthroughId, { type: "block", data: emitBlock });
	return ok(
		`Block added at chapter ${input.semantic_step_index}, step ${resolvedStepIndex}.`,
	);
};

// ── Tool: update_block ──────────────────────────────────────────────────────

const updateBlockHandler: ChatEditToolHandler<UpdateBlockInput> = async (
	ctx,
	input,
) => {
	if (blockContentVariantCount(input.content) !== 1) {
		return fail(
			"Error: update_block.content requires exactly one of { markdown, code, diff }.",
		);
	}

	const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
	if (!active) return fail("No complete walkthrough exists for this PR yet.");
	const walkthroughId = active.id;

	let result: ChatEditToolResult | null = null;
	let emitBlock: WalkthroughBlock | null = null;
	ctx.db.transaction(() => {
		const guarded = assertStillComplete(ctx.db, walkthroughId);
		if ("error" in guarded) {
			result = fail(guarded.error);
			return;
		}

		const existing = ctx.db
			.select({ id: walkthroughBlocks.id })
			.from(walkthroughBlocks)
			.where(
				and(
					eq(walkthroughBlocks.walkthroughId, walkthroughId),
					eq(walkthroughBlocks.phase, "diff_analysis"),
					eq(walkthroughBlocks.semanticStepIndex, input.semantic_step_index),
					eq(walkthroughBlocks.stepIndex, input.step_index),
				),
			)
			.get();
		if (!existing) {
			result = fail(
				`Error: no block exists at chapter ${input.semantic_step_index}, step ${input.step_index}. Use add_block to insert one.`,
			);
			return;
		}

		const blockId = existing.id;
		const built = buildBlock(blockId, input.semantic_step_index, input.step_index, {
			...(input.content.markdown != null
				? { markdown: input.content.markdown }
				: {}),
			...(input.content.code != null ? { code: input.content.code } : {}),
			...(input.content.diff != null ? { diff: input.content.diff } : {}),
		});
		ctx.db
			.update(walkthroughBlocks)
			.set({ type: built.type, data: built.data })
			.where(eq(walkthroughBlocks.id, blockId))
			.run();
		stampLastEdited(ctx.db, walkthroughId, ctx.actor);
		emitBlock = built.block;
	});
	if (result) return result;
	if (!emitBlock) return fail("Internal error: update_block did not persist.");

	ctx.emit(walkthroughId, { type: "block", data: emitBlock });
	return ok(
		`Block at chapter ${input.semantic_step_index}, step ${input.step_index} updated.`,
	);
};

// ── Tool: delete_block ──────────────────────────────────────────────────────

const deleteBlockHandler: ChatEditToolHandler<DeleteBlockInput> = async (
	ctx,
	input,
) => {
	const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
	if (!active) return fail("No complete walkthrough exists for this PR yet.");
	const walkthroughId = active.id;

	let result: ChatEditToolResult | null = null;
	let deletedBlock: {
		id: string;
		semanticStepIndex: number;
		stepIndex: number;
	} | null = null;
	const updatedIssueEvents: WalkthroughIssue[] = [];

	ctx.db.transaction(() => {
		const guarded = assertStillComplete(ctx.db, walkthroughId);
		if ("error" in guarded) {
			result = fail(guarded.error);
			return;
		}

		const existing = ctx.db
			.select()
			.from(walkthroughBlocks)
			.where(
				and(
					eq(walkthroughBlocks.walkthroughId, walkthroughId),
					eq(walkthroughBlocks.phase, "diff_analysis"),
					eq(walkthroughBlocks.semanticStepIndex, input.semantic_step_index),
					eq(walkthroughBlocks.stepIndex, input.step_index),
				),
			)
			.get();
		if (!existing) {
			result = fail(
				`Error: no block exists at chapter ${input.semantic_step_index}, step ${input.step_index}.`,
			);
			return;
		}

		const affected = findIssuesReferencingBlocks(ctx.db, walkthroughId, [
			existing.id,
		]);
		const submitted = affected.filter((a) => a.row.submittedAt !== null);
		if (submitted.length > 0) {
			const titles = submitted.map((a) => `'${a.row.title}'`).join(", ");
			result = fail(
				`Error: cannot delete block — referenced by ${submitted.length} GitHub-submitted issue(s) (${titles}). Submitted issues are immutable.`,
			);
			return;
		}
		const orphaning = affected.filter(
			(a) =>
				a.survivingBlockIds.length === 0 &&
				(a.row.severity === "warning" || a.row.severity === "critical"),
		);
		if (orphaning.length > 0) {
			const titles = orphaning.map((a) => `'${a.row.title}'`).join(", ");
			result = fail(
				`Error: cannot delete block — it is the only block referenced by ${orphaning.length} warning/critical issue(s) (${titles}). Delete those issues first or move their references via update_issue.`,
			);
			return;
		}

		for (const a of affected) {
			ctx.db
				.update(walkthroughIssues)
				.set({ blockIds: JSON.stringify(a.survivingBlockIds) })
				.where(eq(walkthroughIssues.id, a.row.id))
				.run();
			const updated = {
				...a.row,
				blockIds: JSON.stringify(a.survivingBlockIds),
			};
			updatedIssueEvents.push(decodeIssue(updated));
		}

		ctx.db
			.delete(walkthroughBlocks)
			.where(eq(walkthroughBlocks.id, existing.id))
			.run();
		stampLastEdited(ctx.db, walkthroughId, ctx.actor);

		deletedBlock = {
			id: existing.id,
			semanticStepIndex: existing.semanticStepIndex,
			stepIndex: existing.stepIndex,
		};
	});
	if (result) return result;
	if (!deletedBlock) return fail("Internal error: delete_block did not commit.");

	for (const issue of updatedIssueEvents)
		ctx.emit(walkthroughId, { type: "issue", data: issue });
	ctx.emit(walkthroughId, { type: "block:deleted", data: deletedBlock });
	return ok(
		`Block at chapter ${input.semantic_step_index}, step ${input.step_index} deleted (${updatedIssueEvents.length} issue(s) had references scrubbed).`,
	);
};

// ── Tool: update_sentiment ──────────────────────────────────────────────────

const updateSentimentHandler: ChatEditToolHandler<UpdateSentimentInput> =
	async (ctx, input) => {
		const markdown = unwrapJsonWrappedString(input.markdown, "markdown");

		const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
		if (!active) return fail("No complete walkthrough exists for this PR yet.");
		const walkthroughId = active.id;

		let result: ChatEditToolResult | null = null;
		ctx.db.transaction(() => {
			const guarded = assertStillComplete(ctx.db, walkthroughId);
			if ("error" in guarded) {
				result = fail(guarded.error);
				return;
			}
			ctx.db
				.update(walkthroughs)
				.set({ sentiment: markdown })
				.where(eq(walkthroughs.id, walkthroughId))
				.run();
			stampLastEdited(ctx.db, walkthroughId, ctx.actor);
		});
		if (result) return result;

		ctx.emit(walkthroughId, {
			type: "sentiment",
			data: { sentiment: markdown },
		});
		return ok("Sentiment updated.");
	};

// ── Tool: update_rating ─────────────────────────────────────────────────────

const updateRatingHandler: ChatEditToolHandler<UpdateRatingInput> = async (
	ctx,
	input,
) => {
	const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
	if (!active) return fail("No complete walkthrough exists for this PR yet.");
	const walkthroughId = active.id;

	let result: ChatEditToolResult | null = null;
	let emitRating: WalkthroughRating | null = null;
	ctx.db.transaction(() => {
		const guarded = assertStillComplete(ctx.db, walkthroughId);
		if ("error" in guarded) {
			result = fail(guarded.error);
			return;
		}

		const existing = ctx.db
			.select()
			.from(walkthroughRatings)
			.where(
				and(
					eq(walkthroughRatings.walkthroughId, walkthroughId),
					eq(walkthroughRatings.axis, input.axis),
				),
			)
			.get();
		if (!existing) {
			result = fail(
				`Error: no rating exists for axis '${input.axis}'. Use add_rating-style flow (not yet supported) — for now, delete the deleted axis and let the agent re-rate via add_issue's sibling tool. As of v1, deleted ratings cannot be re-added through chat edits.`,
			);
			return;
		}

		const verdict = input.verdict ?? (existing.verdict as WalkthroughRating["verdict"]);
		const confidence =
			input.confidence ?? (existing.confidence as WalkthroughRating["confidence"]);
		const rationale = input.rationale ?? existing.rationale;
		const details = input.details ?? existing.details;
		const citationsInput = input.citations;
		const citations: RatingCitation[] = citationsInput
			? citationsInput.map((c) => ({
					filePath: c.file_path,
					startLine: c.start_line,
					endLine: c.end_line,
					...(c.note !== null ? { note: c.note } : {}),
				}))
			: parseCitations(existing.citations);
		if (verdict !== "pass" && citations.length === 0) {
			result = fail(
				`Error: verdict='${verdict}' requires at least one citation. Provide citations, or set verdict to 'pass'.`,
			);
			return;
		}

		let blockIds: string[];
		if (input.block_refs != null) {
			// Validate refs exist.
			const stepRows = ctx.db
				.select({
					semanticStepIndex: walkthroughBlocks.semanticStepIndex,
					stepIndex: walkthroughBlocks.stepIndex,
				})
				.from(walkthroughBlocks)
				.where(
					and(
						eq(walkthroughBlocks.walkthroughId, walkthroughId),
						eq(walkthroughBlocks.phase, "diff_analysis"),
					),
				)
				.all();
			const known = new Set(
				stepRows.map((r) => `${r.semanticStepIndex}:${r.stepIndex}`),
			);
			const unknown = input.block_refs.filter(
				(r) => !known.has(`${r.semantic_step_index}:${r.step_index}`),
			);
			if (unknown.length > 0) {
				result = fail(
					`Error: block_refs reference unknown blocks: [${unknown.map((r) => `(${r.semantic_step_index},${r.step_index})`).join(", ")}].`,
				);
				return;
			}
			const seen = new Set<string>();
			const unique = input.block_refs.filter((r) => {
				const k = `${r.semantic_step_index}:${r.step_index}`;
				if (seen.has(k)) return false;
				seen.add(k);
				return true;
			});
			blockIds = unique.map((r) =>
				blockIdFor(walkthroughId, r.semantic_step_index, r.step_index),
			);
		} else {
			blockIds = parseBlockIds(existing.blockIds);
		}

		ctx.db
			.update(walkthroughRatings)
			.set({
				verdict,
				confidence,
				rationale,
				details,
				citations: JSON.stringify(citations),
				blockIds: JSON.stringify(blockIds),
			})
			.where(eq(walkthroughRatings.id, existing.id))
			.run();
		stampLastEdited(ctx.db, walkthroughId, ctx.actor);

		emitRating = {
			axis: input.axis,
			verdict,
			confidence,
			rationale,
			details,
			citations,
			blockIds,
		};
	});
	if (result) return result;
	if (!emitRating) return fail("Internal error: update_rating did not persist.");

	ctx.emit(walkthroughId, { type: "rating", data: emitRating });
	return ok(`Rating for axis '${input.axis}' updated.`);
};

// ── Tool: delete_rating ─────────────────────────────────────────────────────

const deleteRatingHandler: ChatEditToolHandler<DeleteRatingInput> = async (
	ctx,
	input,
) => {
	const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
	if (!active) return fail("No complete walkthrough exists for this PR yet.");
	const walkthroughId = active.id;

	let result: ChatEditToolResult | null = null;
	ctx.db.transaction(() => {
		const guarded = assertStillComplete(ctx.db, walkthroughId);
		if ("error" in guarded) {
			result = fail(guarded.error);
			return;
		}
		const existing = ctx.db
			.select({ id: walkthroughRatings.id })
			.from(walkthroughRatings)
			.where(
				and(
					eq(walkthroughRatings.walkthroughId, walkthroughId),
					eq(walkthroughRatings.axis, input.axis),
				),
			)
			.get();
		if (!existing) {
			result = fail(`Error: no rating exists for axis '${input.axis}'.`);
			return;
		}
		ctx.db
			.delete(walkthroughRatings)
			.where(eq(walkthroughRatings.id, existing.id))
			.run();
		stampLastEdited(ctx.db, walkthroughId, ctx.actor);
	});
	if (result) return result;

	ctx.emit(walkthroughId, {
		type: "rating:deleted",
		data: { axis: input.axis },
	});
	return ok(
		`Rating for axis '${input.axis}' deleted. (status stays 'complete'; passesCompletenessGate may now be false.)`,
	);
};

// ── Tool: add_issue ─────────────────────────────────────────────────────────

const addIssueEditHandler: ChatEditToolHandler<AddIssueEditInput> = async (
	ctx,
	input,
) => {
	const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
	if (!active) return fail("No complete walkthrough exists for this PR yet.");
	const walkthroughId = active.id;

	const issueId = await computeIssueId(
		walkthroughId,
		input.title,
		input.file_path,
		input.start_line,
	);

	let result: ChatEditToolResult | null = null;
	let emitIssue: WalkthroughIssue | null = null;
	ctx.db.transaction(() => {
		const guarded = assertStillComplete(ctx.db, walkthroughId);
		if ("error" in guarded) {
			result = fail(guarded.error);
			return;
		}

		// Validate block_refs.
		const stepRows = ctx.db
			.select({
				semanticStepIndex: walkthroughBlocks.semanticStepIndex,
				stepIndex: walkthroughBlocks.stepIndex,
			})
			.from(walkthroughBlocks)
			.where(
				and(
					eq(walkthroughBlocks.walkthroughId, walkthroughId),
					eq(walkthroughBlocks.phase, "diff_analysis"),
				),
			)
			.all();
		const known = new Set(
			stepRows.map((r) => `${r.semanticStepIndex}:${r.stepIndex}`),
		);
		const unknown = input.block_refs.filter(
			(r) => !known.has(`${r.semantic_step_index}:${r.step_index}`),
		);
		if (unknown.length > 0) {
			result = fail(
				`Error: block_refs reference unknown blocks: [${unknown.map((r) => `(${r.semantic_step_index},${r.step_index})`).join(", ")}].`,
			);
			return;
		}

		// Refuse if an issue with the same id already exists — the agent
		// should use update_issue instead.
		const existing = ctx.db
			.select({ id: walkthroughIssues.id })
			.from(walkthroughIssues)
			.where(eq(walkthroughIssues.id, issueId))
			.get();
		if (existing) {
			result = fail(
				`Error: an issue with title '${input.title}' at ${input.file_path ?? "(no file)"}:${input.start_line ?? "?"} already exists (id=${issueId}). Use update_issue with that id to modify it.`,
			);
			return;
		}

		const seen = new Set<string>();
		const unique = input.block_refs.filter((r) => {
			const k = `${r.semantic_step_index}:${r.step_index}`;
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		});
		const blockIds = unique.map((r) =>
			blockIdFor(walkthroughId, r.semantic_step_index, r.step_index),
		);

		const existingRows = ctx.db
			.select({ order: walkthroughIssues.order })
			.from(walkthroughIssues)
			.where(eq(walkthroughIssues.walkthroughId, walkthroughId))
			.all();
		const order = existingRows.length;
		const now = new Date().toISOString();
		ctx.db
			.insert(walkthroughIssues)
			.values({
				id: issueId,
				walkthroughId,
				order,
				severity: input.severity,
				title: input.title,
				description: input.description,
				filePath: input.file_path,
				startLine: input.start_line,
				endLine: input.end_line,
				blockIds: JSON.stringify(blockIds),
				createdAt: now,
			})
			.run();
		stampLastEdited(ctx.db, walkthroughId, ctx.actor);

		emitIssue = {
			id: issueId,
			severity: input.severity,
			title: input.title,
			description: input.description,
			blockIds,
			...(input.file_path !== null ? { filePath: input.file_path } : {}),
			...(input.start_line !== null ? { startLine: input.start_line } : {}),
			...(input.end_line !== null ? { endLine: input.end_line } : {}),
		};
	});
	if (result) return result;
	if (!emitIssue) return fail("Internal error: add_issue did not persist.");

	ctx.emit(walkthroughId, { type: "issue", data: emitIssue });
	return ok(`Issue added: [${input.severity}] ${input.title} (id=${issueId}).`);
};

// ── Tool: update_issue ──────────────────────────────────────────────────────

const updateIssueHandler: ChatEditToolHandler<UpdateIssueInput> = async (
	ctx,
	input,
) => {
	const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
	if (!active) return fail("No complete walkthrough exists for this PR yet.");
	const walkthroughId = active.id;

	let result: ChatEditToolResult | null = null;
	let emitIssue: WalkthroughIssue | null = null;
	ctx.db.transaction(() => {
		const guarded = assertStillComplete(ctx.db, walkthroughId);
		if ("error" in guarded) {
			result = fail(guarded.error);
			return;
		}

		const existing = ctx.db
			.select()
			.from(walkthroughIssues)
			.where(
				and(
					eq(walkthroughIssues.id, input.issue_id),
					eq(walkthroughIssues.walkthroughId, walkthroughId),
				),
			)
			.get();
		if (!existing) {
			result = fail(
				`Error: no issue with id='${input.issue_id}' exists in the active walkthrough.`,
			);
			return;
		}
		if (existing.submittedAt !== null) {
			result = fail(
				`Error: issue '${existing.title}' has been pushed to GitHub (submittedAt=${existing.submittedAt}). Submitted issues are immutable.`,
			);
			return;
		}

		let blockIds = parseBlockIds(existing.blockIds);
		if (input.block_refs != null) {
			const stepRows = ctx.db
				.select({
					semanticStepIndex: walkthroughBlocks.semanticStepIndex,
					stepIndex: walkthroughBlocks.stepIndex,
				})
				.from(walkthroughBlocks)
				.where(
					and(
						eq(walkthroughBlocks.walkthroughId, walkthroughId),
						eq(walkthroughBlocks.phase, "diff_analysis"),
					),
				)
				.all();
			const known = new Set(
				stepRows.map((r) => `${r.semanticStepIndex}:${r.stepIndex}`),
			);
			const unknown = input.block_refs.filter(
				(r) => !known.has(`${r.semantic_step_index}:${r.step_index}`),
			);
			if (unknown.length > 0) {
				result = fail(
					`Error: block_refs reference unknown blocks: [${unknown.map((r) => `(${r.semantic_step_index},${r.step_index})`).join(", ")}].`,
				);
				return;
			}
			const seen = new Set<string>();
			const unique = input.block_refs.filter((r) => {
				const k = `${r.semantic_step_index}:${r.step_index}`;
				if (seen.has(k)) return false;
				seen.add(k);
				return true;
			});
			blockIds = unique.map((r) =>
				blockIdFor(walkthroughId, r.semantic_step_index, r.step_index),
			);
		}

		const patch: {
			severity?: string;
			title?: string;
			description?: string;
			filePath?: string | null;
			startLine?: number | null;
			endLine?: number | null;
			blockIds?: string;
		} = {};
		if (input.severity != null) patch.severity = input.severity;
		if (input.title != null) patch.title = input.title;
		if (input.description != null) patch.description = input.description;
		if ("file_path" in input && input.file_path !== undefined)
			patch.filePath = input.file_path;
		if ("start_line" in input && input.start_line !== undefined)
			patch.startLine = input.start_line;
		if ("end_line" in input && input.end_line !== undefined)
			patch.endLine = input.end_line;
		if (input.block_refs != null) patch.blockIds = JSON.stringify(blockIds);

		if (Object.keys(patch).length === 0) {
			result = fail("Error: update_issue needs at least one field to update.");
			return;
		}

		ctx.db
			.update(walkthroughIssues)
			.set(patch)
			.where(eq(walkthroughIssues.id, existing.id))
			.run();
		stampLastEdited(ctx.db, walkthroughId, ctx.actor);

		const updatedRow = { ...existing, ...patch } as typeof existing;
		emitIssue = decodeIssue(updatedRow);
	});
	if (result) return result;
	if (!emitIssue) return fail("Internal error: update_issue did not persist.");

	ctx.emit(walkthroughId, { type: "issue", data: emitIssue });
	return ok(`Issue ${input.issue_id} updated.`);
};

// ── Tool: delete_issue ──────────────────────────────────────────────────────

const deleteIssueHandler: ChatEditToolHandler<DeleteIssueInput> = async (
	ctx,
	input,
) => {
	const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
	if (!active) return fail("No complete walkthrough exists for this PR yet.");
	const walkthroughId = active.id;

	let result: ChatEditToolResult | null = null;
	const deletedThreadIds: string[] = [];
	ctx.db.transaction(() => {
		const guarded = assertStillComplete(ctx.db, walkthroughId);
		if ("error" in guarded) {
			result = fail(guarded.error);
			return;
		}

		const existing = ctx.db
			.select()
			.from(walkthroughIssues)
			.where(
				and(
					eq(walkthroughIssues.id, input.issue_id),
					eq(walkthroughIssues.walkthroughId, walkthroughId),
				),
			)
			.get();
		if (!existing) {
			result = fail(`Error: no issue with id='${input.issue_id}' exists.`);
			return;
		}
		if (existing.submittedAt !== null) {
			result = fail(
				`Error: issue '${existing.title}' has been pushed to GitHub (submittedAt=${existing.submittedAt}). Cannot delete.`,
			);
			return;
		}

		// Capture linked thread ids before the FK cascade fires so we can
		// broadcast `thread:deleted` events post-commit.
		const linkedThreads = ctx.db
			.select({ id: commentThreads.id })
			.from(commentThreads)
			.where(eq(commentThreads.walkthroughIssueId, existing.id))
			.all();
		for (const t of linkedThreads) deletedThreadIds.push(t.id);

		// FK on comment_threads.walkthroughIssueId is ON DELETE CASCADE — the
		// linked threads (and their messages via thread cascade) drop with the
		// issue.
		ctx.db
			.delete(walkthroughIssues)
			.where(eq(walkthroughIssues.id, existing.id))
			.run();
		stampLastEdited(ctx.db, walkthroughId, ctx.actor);
	});
	if (result) return result;

	for (const threadId of deletedThreadIds) {
		ctx.broadcastThreadEvent({ type: "thread:deleted", data: { threadId } });
	}
	ctx.emit(walkthroughId, { type: "issue:deleted", data: { id: input.issue_id } });
	return ok(
		`Issue ${input.issue_id} deleted${deletedThreadIds.length > 0 ? ` (${deletedThreadIds.length} linked thread(s) cascaded)` : ""}.`,
	);
};

// ── Tool: add_issue_comment ─────────────────────────────────────────────────

const addIssueCommentEditHandler: ChatEditToolHandler<
	AddIssueCommentEditInput
> = async (ctx, input) => {
	if (input.end_line < input.start_line) {
		return fail(
			`Error: end_line (${input.end_line}) is before start_line (${input.start_line}).`,
		);
	}

	const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
	if (!active) return fail("No complete walkthrough exists for this PR yet.");
	const walkthroughId = active.id;

	const threadId = await computeAnchorThreadId(
		walkthroughId,
		input.issue_id,
		input.file_path,
		input.start_line,
		input.end_line,
		input.diff_side,
	);
	const messageId = `${threadId}-msg-0`;

	let result: ChatEditToolResult | null = null;
	let createdThread: CommentThread | null = null;
	let createdMessage: ThreadMessage | null = null;
	let sessionId = "";
	ctx.db.transaction(() => {
		const guarded = assertStillComplete(ctx.db, walkthroughId);
		if ("error" in guarded) {
			result = fail(guarded.error);
			return;
		}

		const issue = ctx.db
			.select({
				id: walkthroughIssues.id,
				submittedAt: walkthroughIssues.submittedAt,
			})
			.from(walkthroughIssues)
			.where(
				and(
					eq(walkthroughIssues.id, input.issue_id),
					eq(walkthroughIssues.walkthroughId, walkthroughId),
				),
			)
			.get();
		if (!issue) {
			result = fail(
				`Error: no issue with id='${input.issue_id}' exists in the active walkthrough.`,
			);
			return;
		}
		if (issue.submittedAt !== null) {
			result = fail(
				`Error: issue '${input.issue_id}' has been pushed to GitHub. Cannot add comments to submitted issues.`,
			);
			return;
		}

		sessionId = guarded.row.reviewSessionId;
		const now = new Date().toISOString();

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
				set: { body: input.body, editedAt: now },
			})
			.run();
		stampLastEdited(ctx.db, walkthroughId, ctx.actor);

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
			result = fail(
				"Internal error: comment upsert succeeded but read-back returned no row.",
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
			messageType: persistedMessage.messageType as ThreadMessage["messageType"],
			codeSuggestion: persistedMessage.codeSuggestion ?? null,
			createdAt: persistedMessage.createdAt,
			editedAt: persistedMessage.editedAt ?? null,
			externalId: persistedMessage.externalId ?? null,
		};
	});
	if (result) return result;
	if (!createdThread || !createdMessage) {
		return fail("Internal error: add_issue_comment did not persist.");
	}

	ctx.broadcastThreadEvent({
		type: "thread:created",
		data: { sessionId, thread: createdThread, message: createdMessage },
	});
	return ok(
		`Comment posted on ${input.file_path}:${input.start_line}${
			input.end_line !== input.start_line ? `-${input.end_line}` : ""
		} for issue ${input.issue_id}. Thread id: ${threadId}.`,
	);
};

// ── Tool: update_issue_comment ──────────────────────────────────────────────

const updateIssueCommentHandler: ChatEditToolHandler<
	UpdateIssueCommentInput
> = async (ctx, input) => {
	const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
	if (!active) return fail("No complete walkthrough exists for this PR yet.");
	const walkthroughId = active.id;

	let result: ChatEditToolResult | null = null;
	let updatedMessage: ThreadMessage | null = null;
	let parentThreadId = "";
	ctx.db.transaction(() => {
		const guarded = assertStillComplete(ctx.db, walkthroughId);
		if ("error" in guarded) {
			result = fail(guarded.error);
			return;
		}

		const message = ctx.db
			.select()
			.from(threadMessages)
			.where(eq(threadMessages.id, input.thread_message_id))
			.get();
		if (!message) {
			result = fail(
				`Error: no thread message with id='${input.thread_message_id}' exists.`,
			);
			return;
		}
		const thread = ctx.db
			.select()
			.from(commentThreads)
			.where(eq(commentThreads.id, message.threadId))
			.get();
		if (!thread) {
			result = fail(
				`Error: parent thread for message ${input.thread_message_id} is gone.`,
			);
			return;
		}
		if (!thread.walkthroughIssueId) {
			result = fail(
				`Error: thread ${thread.id} is not linked to a walkthrough issue — only AI-authored issue comments can be edited via this tool.`,
			);
			return;
		}
		const issue = ctx.db
			.select({
				id: walkthroughIssues.id,
				walkthroughId: walkthroughIssues.walkthroughId,
				submittedAt: walkthroughIssues.submittedAt,
			})
			.from(walkthroughIssues)
			.where(eq(walkthroughIssues.id, thread.walkthroughIssueId))
			.get();
		if (!issue || issue.walkthroughId !== walkthroughId) {
			result = fail(
				`Error: comment ${input.thread_message_id} does not belong to the active walkthrough for this PR.`,
			);
			return;
		}
		if (issue.submittedAt !== null) {
			result = fail(
				`Error: parent issue has been pushed to GitHub. Cannot edit comments on submitted issues.`,
			);
			return;
		}

		const now = new Date().toISOString();
		ctx.db
			.update(threadMessages)
			.set({ body: input.body, editedAt: now })
			.where(eq(threadMessages.id, message.id))
			.run();
		stampLastEdited(ctx.db, walkthroughId, ctx.actor);

		parentThreadId = thread.id;
		updatedMessage = {
			id: message.id,
			threadId: message.threadId,
			authorRole: message.authorRole as ThreadMessage["authorRole"],
			authorName: message.authorName,
			authorAvatarUrl: message.authorAvatarUrl ?? null,
			body: input.body,
			messageType: message.messageType as ThreadMessage["messageType"],
			codeSuggestion: message.codeSuggestion ?? null,
			createdAt: message.createdAt,
			editedAt: now,
			externalId: message.externalId ?? null,
		};
	});
	if (result) return result;
	if (!updatedMessage) {
		return fail("Internal error: update_issue_comment did not persist.");
	}

	ctx.broadcastThreadEvent({
		type: "thread:message:edited",
		data: { threadId: parentThreadId, message: updatedMessage },
	});
	return ok(`Comment ${input.thread_message_id} updated.`);
};

// ── Tool: delete_issue_comment ──────────────────────────────────────────────

const deleteIssueCommentHandler: ChatEditToolHandler<
	DeleteIssueCommentInput
> = async (ctx, input) => {
	const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
	if (!active) return fail("No complete walkthrough exists for this PR yet.");
	const walkthroughId = active.id;

	let result: ChatEditToolResult | null = null;
	let parentThreadId = "";
	let threadAlsoDeleted = false;
	ctx.db.transaction(() => {
		const guarded = assertStillComplete(ctx.db, walkthroughId);
		if ("error" in guarded) {
			result = fail(guarded.error);
			return;
		}

		const message = ctx.db
			.select()
			.from(threadMessages)
			.where(eq(threadMessages.id, input.thread_message_id))
			.get();
		if (!message) {
			result = fail(
				`Error: no thread message with id='${input.thread_message_id}' exists.`,
			);
			return;
		}
		const thread = ctx.db
			.select()
			.from(commentThreads)
			.where(eq(commentThreads.id, message.threadId))
			.get();
		if (!thread) {
			result = fail(
				`Error: parent thread for message ${input.thread_message_id} is gone.`,
			);
			return;
		}
		if (!thread.walkthroughIssueId) {
			result = fail(
				`Error: thread ${thread.id} is not linked to a walkthrough issue.`,
			);
			return;
		}
		const issue = ctx.db
			.select({
				id: walkthroughIssues.id,
				walkthroughId: walkthroughIssues.walkthroughId,
				submittedAt: walkthroughIssues.submittedAt,
			})
			.from(walkthroughIssues)
			.where(eq(walkthroughIssues.id, thread.walkthroughIssueId))
			.get();
		if (!issue || issue.walkthroughId !== walkthroughId) {
			result = fail(
				`Error: comment ${input.thread_message_id} does not belong to the active walkthrough.`,
			);
			return;
		}
		if (issue.submittedAt !== null) {
			result = fail(
				`Error: parent issue has been pushed to GitHub. Cannot delete comments on submitted issues.`,
			);
			return;
		}

		parentThreadId = thread.id;
		ctx.db
			.delete(threadMessages)
			.where(eq(threadMessages.id, message.id))
			.run();

		// If the thread is now empty, drop the thread row too.
		const remaining = ctx.db
			.select({ id: threadMessages.id })
			.from(threadMessages)
			.where(eq(threadMessages.threadId, thread.id))
			.all();
		if (remaining.length === 0) {
			ctx.db
				.delete(commentThreads)
				.where(eq(commentThreads.id, thread.id))
				.run();
			threadAlsoDeleted = true;
		}
		stampLastEdited(ctx.db, walkthroughId, ctx.actor);
	});
	if (result) return result;

	ctx.broadcastThreadEvent({
		type: "thread:message:deleted",
		data: { threadId: parentThreadId, messageId: input.thread_message_id },
	});
	if (threadAlsoDeleted) {
		ctx.broadcastThreadEvent({
			type: "thread:deleted",
			data: { threadId: parentThreadId },
		});
	}
	return ok(
		`Comment ${input.thread_message_id} deleted${threadAlsoDeleted ? " (thread was empty and was also removed)" : ""}.`,
	);
};

// ── Canonical spec list ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const EDIT_TOOL_SPECS: Array<ChatEditToolSpec<any>> = [
	{
		name: "get_walkthrough_for_edit",
		description:
			"Read-only. Returns the full editable walkthrough state — walkthroughId, summary, risk, sentiment, every chapter + block + issue + comment + axis rating — plus a `validation` block. Call this FIRST before any edit so you have exact targeting keys (semantic_step_index, step_index, issue_id, axis, thread_message_id). The target is always the latest `status='complete'` walkthrough for this PR.",
		inputSchema: getWalkthroughForEditSchema,
		handler: getWalkthroughForEditHandler,
	},
	{
		name: "update_overview",
		description:
			"Update the walkthrough's summary and/or risk_level. Partial — supply one or both. Walkthrough stays status='complete'.",
		inputSchema: updateOverviewSchema,
		handler: updateOverviewHandler,
	},
	{
		name: "add_semantic_step",
		description:
			"Insert a new chapter (semantic step) into the walkthrough. Requires a free semantic_step_index, a title, and exactly one initial_block. Gaps in the index sequence are allowed (e.g. 0,1,3 → can insert 2 or 99).",
		inputSchema: addSemanticStepEditSchema,
		handler: addSemanticStepEditHandler,
	},
	{
		name: "update_semantic_step",
		description:
			"Update a chapter's title and/or summary. Chapter must already exist. Partial — at least one of title/summary required.",
		inputSchema: updateSemanticStepSchema,
		handler: updateSemanticStepHandler,
	},
	{
		name: "delete_semantic_step",
		description:
			"Delete a chapter and all its blocks. Rejected if any block is the only reference for a warning/critical issue (delete those issues first), or if any referencing issue has been pushed to GitHub.",
		inputSchema: deleteSemanticStepSchema,
		handler: deleteSemanticStepHandler,
	},
	{
		name: "add_block",
		description:
			"Insert an atomic block (markdown/code/diff) into an existing chapter. `step_index` defaults to MAX(step_index)+1 inside the chapter; supply it explicitly to insert at a specific position (rejected on collision).",
		inputSchema: addBlockSchema,
		handler: addBlockHandler,
	},
	{
		name: "update_block",
		description:
			"Replace an existing block's content. Same content shape as add_block; the block at (semantic_step_index, step_index) must already exist.",
		inputSchema: updateBlockSchema,
		handler: updateBlockHandler,
	},
	{
		name: "delete_block",
		description:
			"Delete a single block. Rejected if it is the only reference for a warning/critical issue, or if any referencing issue has been pushed to GitHub.",
		inputSchema: deleteBlockSchema,
		handler: deleteBlockHandler,
	},
	{
		name: "update_sentiment",
		description:
			"Replace the 'Overall Sentiment' markdown. 2–4 sentences, direct verdict.",
		inputSchema: updateSentimentSchema,
		handler: updateSentimentHandler,
	},
	{
		name: "update_rating",
		description:
			"Update an existing axis rating (verdict, confidence, rationale, details, citations, block_refs). Partial — only supplied fields are written.",
		inputSchema: updateRatingSchema,
		handler: updateRatingHandler,
	},
	{
		name: "delete_rating",
		description:
			"Remove the rating row for an axis. Does NOT regress lastCompletedPhase — the walkthrough's status stays 'complete'. `validation.passesCompletenessGate` will surface false on the next get_walkthrough_for_edit call until a future tool re-adds an axis (not yet supported in v1).",
		inputSchema: deleteRatingSchema,
		handler: deleteRatingHandler,
	},
	{
		name: "add_issue",
		description:
			"Add a new flagged issue. Same shape as the generation flag_issue tool — severity, title, description, block_refs (must reference existing blocks), file_path/start_line/end_line. Refused if an issue with the same (title, file, start_line) already exists; use update_issue with that issue_id instead.",
		inputSchema: addIssueEditSchema,
		handler: addIssueEditHandler,
	},
	{
		name: "update_issue",
		description:
			"Update fields on an existing issue, keyed by issue_id. Partial — any subset of severity/title/description/block_refs/file_path/start_line/end_line. The issue_id is preserved even when canonicalizing fields change. Rejected if the issue has been pushed to GitHub.",
		inputSchema: updateIssueSchema,
		handler: updateIssueHandler,
	},
	{
		name: "delete_issue",
		description:
			"Delete an issue and cascade-delete any comment threads linked to it. Rejected if the issue has been pushed to GitHub.",
		inputSchema: deleteIssueSchema,
		handler: deleteIssueHandler,
	},
	{
		name: "add_issue_comment",
		description:
			"Add a line-anchored inline comment to an existing issue. Same shape as the generation add_issue_comment tool. Idempotent on the deterministic anchor (issue_id + file + line range + diff_side) — a retry replaces the body.",
		inputSchema: addIssueCommentEditSchema,
		handler: addIssueCommentEditHandler,
	},
	{
		name: "update_issue_comment",
		description:
			"Replace the body of an existing AI-authored issue comment. Rejected if the parent issue has been pushed to GitHub.",
		inputSchema: updateIssueCommentSchema,
		handler: updateIssueCommentHandler,
	},
	{
		name: "delete_issue_comment",
		description:
			"Delete an AI-authored issue comment. If it was the last message in its thread, the thread is removed too. Rejected if the parent issue has been pushed to GitHub.",
		inputSchema: deleteIssueCommentSchema,
		handler: deleteIssueCommentHandler,
	},
];

// The SDK adapter lives in chat-mcp-tools.ts (`createChatMcpServer`), which
// iterates the unified CHAT_TOOL_SPECS array (read + edit) and wraps each
// spec via the Claude SDK's `tool()` helper. The HTTP route in
// chat-context.ts dispatches off the same CHAT_TOOL_SPECS list. Both
// transports share one source of truth.
