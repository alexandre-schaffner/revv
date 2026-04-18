import { Context, Effect, Layer } from 'effect';
import { and, eq, ne } from 'drizzle-orm';
import type {
	Walkthrough,
	WalkthroughBlock,
	WalkthroughIssue,
	WalkthroughRating,
	WalkthroughTokenUsage,
	RatingAxis,
	RatingCitation,
	Verdict,
	Confidence,
	RiskLevel,
	CarriedOverIssue,
} from '@revv/shared';
import { ReviewError } from '../domain/errors';
import { walkthroughs } from '../db/schema/walkthroughs';
import { walkthroughBlocks } from '../db/schema/walkthrough-blocks';
import { walkthroughIssues } from '../db/schema/walkthrough-issues';
import { walkthroughRatings } from '../db/schema/walkthrough-ratings';
import { DbService } from './Db';

// ── Row-to-domain converter ─────────────────────────────────────────────────

function rowToRating(row: typeof walkthroughRatings.$inferSelect): WalkthroughRating {
	let citations: RatingCitation[] = [];
	try {
		const parsed: unknown = JSON.parse(row.citations);
		if (Array.isArray(parsed)) {
			citations = parsed.filter(
				(v): v is RatingCitation =>
					typeof v === 'object' &&
					v !== null &&
					typeof (v as { filePath?: unknown }).filePath === 'string' &&
					typeof (v as { startLine?: unknown }).startLine === 'number' &&
					typeof (v as { endLine?: unknown }).endLine === 'number',
			);
		}
	} catch {
		// Corrupt JSON — fall back to no citations.
	}

	let blockIds: string[] = [];
	try {
		const parsed: unknown = JSON.parse(row.blockIds);
		if (Array.isArray(parsed)) {
			blockIds = parsed.filter((v): v is string => typeof v === 'string');
		}
	} catch {
		// Corrupt JSON — fall back to no block links.
	}

	return {
		axis: row.axis as RatingAxis,
		verdict: row.verdict as Verdict,
		confidence: row.confidence as Confidence,
		rationale: row.rationale,
		details: row.details,
		citations,
		blockIds,
	};
}

function rowToWalkthrough(
	row: typeof walkthroughs.$inferSelect,
	blocks: Array<typeof walkthroughBlocks.$inferSelect>,
	issues: Array<typeof walkthroughIssues.$inferSelect>,
	ratings: Array<typeof walkthroughRatings.$inferSelect>,
): Walkthrough {
	const sortedBlocks = [...blocks]
		.sort((a, b) => a.order - b.order)
		.map((b) => JSON.parse(b.data) as WalkthroughBlock);

	const sortedIssues = [...issues]
		.sort((a, b) => a.order - b.order)
		.map((i): WalkthroughIssue => {
			let blockIds: string[] = [];
			try {
				const parsed: unknown = JSON.parse(i.blockIds);
				if (Array.isArray(parsed)) {
					blockIds = parsed.filter((v): v is string => typeof v === 'string');
				}
			} catch {
				// Legacy row or corrupt JSON — fall back to empty linkage.
			}
			return {
				id: i.id,
				severity: i.severity as WalkthroughIssue['severity'],
				title: i.title,
				description: i.description,
				blockIds,
				...(i.filePath !== null ? { filePath: i.filePath } : {}),
				...(i.startLine !== null ? { startLine: i.startLine } : {}),
				...(i.endLine !== null ? { endLine: i.endLine } : {}),
			};
		});

	// Ratings are ordered by insertion (createdAt) so the grid receives them
	// in arrival order. The UI re-orders by canonical RATING_AXES for display.
	const sortedRatings = [...ratings]
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
		.map(rowToRating);

	return {
		id: row.id,
		reviewSessionId: row.reviewSessionId,
		pullRequestId: row.pullRequestId,
		summary: row.summary,
		blocks: sortedBlocks,
		issues: sortedIssues,
		ratings: sortedRatings,
		riskLevel: row.riskLevel as RiskLevel,
		generatedAt: row.generatedAt,
		modelUsed: row.modelUsed,
		tokenUsage: JSON.parse(row.tokenUsage) as WalkthroughTokenUsage,
		prHeadSha: row.prHeadSha,
	};
}

// ── Service definition ──────────────────────────────────────────────────────

export class WalkthroughService extends Context.Tag('WalkthroughService')<
	WalkthroughService,
	{
		/** Insert a new walkthrough row at start of generation. Returns the new ID. */
		readonly createPartial: (params: {
			reviewSessionId: string;
			prId: string;
			summary: string;
			riskLevel: RiskLevel;
			modelUsed: string;
			prHeadSha: string;
		}) => Effect.Effect<string, ReviewError, DbService>;

		/** Persist a single block row. */
		readonly addBlock: (
			walkthroughId: string,
			block: WalkthroughBlock,
		) => Effect.Effect<void, ReviewError, DbService>;

		/** Persist a single issue row. */
		readonly addIssue: (
			walkthroughId: string,
			issue: WalkthroughIssue,
			order: number,
		) => Effect.Effect<void, ReviewError, DbService>;

		/** Persist (or replace) a single rating row for an axis. */
		readonly addRating: (
			walkthroughId: string,
			rating: WalkthroughRating,
		) => Effect.Effect<void, ReviewError, DbService>;

		/** Mark generation complete with final token usage. */
		readonly markComplete: (
			walkthroughId: string,
			tokenUsage: WalkthroughTokenUsage,
		) => Effect.Effect<void, ReviewError, DbService>;

		/** Mark generation as errored. */
		readonly markError: (
			walkthroughId: string,
		) => Effect.Effect<void, never, DbService>;

		/** Get a complete (cached) walkthrough by PR + sha. */
		readonly getCached: (
			prId: string,
			headSha: string,
		) => Effect.Effect<Walkthrough | null, never, DbService>;

		/** Get an incomplete (generating/error) walkthrough + its blocks for resume. */
		readonly getPartial: (
			prId: string,
			headSha: string,
		) => Effect.Effect<(Walkthrough & { status: 'generating' | 'error'; opencodeSessionId: string | null }) | null, never, DbService>;

		readonly invalidateForPr: (
			prId: string,
		) => Effect.Effect<void, never, DbService>;

		/** Persist the opencode session ID for resumption. */
		readonly setOpencodeSessionId: (
			walkthroughId: string,
			sessionId: string,
		) => Effect.Effect<void, never, DbService>;

		/** Store carried-over issues from a regenerate request, keyed by prId. */
		readonly setPendingCarriedOver: (
			prId: string,
			issues: CarriedOverIssue[],
		) => Effect.Effect<void, never, never>;

		/**
		 * Read and clear carried-over issues for a prId.
		 * Returns empty array if none stored.
		 */
		readonly consumePendingCarriedOver: (
			prId: string,
		) => Effect.Effect<CarriedOverIssue[], never, never>;
	}
>() {}

// ── Live implementation ─────────────────────────────────────────────────────

// In-memory store for carried-over issues bridging POST /regenerate → GET /walkthrough SSE.
// Keyed by prId. Cleared on read. Transient — lost on server restart (acceptable).
const pendingCarriedOverMap = new Map<string, CarriedOverIssue[]>();

export const WalkthroughServiceLive = Layer.succeed(WalkthroughService, {
	createPartial: (params) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const id = crypto.randomUUID();
			const generatedAt = new Date().toISOString();

			yield* Effect.try({
				try: () =>
					db
						.insert(walkthroughs)
						.values({
							id,
							reviewSessionId: params.reviewSessionId,
							pullRequestId: params.prId,
							summary: params.summary,
							riskLevel: params.riskLevel,
							status: 'generating',
							generatedAt,
							modelUsed: params.modelUsed,
							tokenUsage: '{}',
							prHeadSha: params.prHeadSha,
						})
						.run(),
				catch: (e) =>
					new ReviewError({ message: `Failed to create walkthrough: ${String(e)}` }),
			});

			return id;
		}),

	addBlock: (walkthroughId, block) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;

			yield* Effect.try({
				try: () =>
					db
						.insert(walkthroughBlocks)
						.values({
							id: crypto.randomUUID(),
							walkthroughId,
							order: block.order,
							type: block.type,
							data: JSON.stringify(block),
							createdAt: new Date().toISOString(),
						})
						.run(),
				catch: (e) =>
					new ReviewError({ message: `Failed to save walkthrough block: ${String(e)}` }),
			});
		}),

	markComplete: (walkthroughId, tokenUsage) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;

			yield* Effect.try({
				try: () =>
					db
						.update(walkthroughs)
						.set({ status: 'complete', tokenUsage: JSON.stringify(tokenUsage) })
						.where(eq(walkthroughs.id, walkthroughId))
						.run(),
				catch: (e) =>
					new ReviewError({ message: `Failed to mark walkthrough complete: ${String(e)}` }),
			});
		}),

	markError: (walkthroughId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;

			yield* Effect.try({
				try: () =>
					db
						.update(walkthroughs)
						.set({ status: 'error' })
						.where(eq(walkthroughs.id, walkthroughId))
						.run(),
				catch: (e) =>
					new ReviewError({ message: `Failed to mark walkthrough error: ${String(e)}` }),
			}).pipe(Effect.catchAll(() => Effect.void));
		}),

	addIssue: (walkthroughId, issue, order) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;

			yield* Effect.try({
				try: () =>
					db
						.insert(walkthroughIssues)
						.values({
							id: issue.id,
							walkthroughId,
							order,
							severity: issue.severity,
							title: issue.title,
							description: issue.description,
							filePath: issue.filePath ?? null,
							startLine: issue.startLine ?? null,
							endLine: issue.endLine ?? null,
							blockIds: JSON.stringify(issue.blockIds ?? []),
							createdAt: new Date().toISOString(),
						})
						.run(),
				catch: (e) =>
					new ReviewError({ message: `Failed to save walkthrough issue: ${String(e)}` }),
			});
		}),

	addRating: (walkthroughId, rating) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;

			// INSERT ... ON CONFLICT DO UPDATE keeps persistence idempotent: if a
			// resume flow re-emits a previously-rated axis, we don't trip the
			// UNIQUE (walkthroughId, axis) index, we just refresh the row.
			yield* Effect.try({
				try: () =>
					db
						.insert(walkthroughRatings)
						.values({
							id: crypto.randomUUID(),
							walkthroughId,
							axis: rating.axis,
							verdict: rating.verdict,
							confidence: rating.confidence,
							rationale: rating.rationale,
							details: rating.details,
							citations: JSON.stringify(rating.citations ?? []),
							blockIds: JSON.stringify(rating.blockIds ?? []),
							createdAt: new Date().toISOString(),
						})
						.onConflictDoUpdate({
							target: [walkthroughRatings.walkthroughId, walkthroughRatings.axis],
							set: {
								verdict: rating.verdict,
								confidence: rating.confidence,
								rationale: rating.rationale,
								details: rating.details,
								citations: JSON.stringify(rating.citations ?? []),
								blockIds: JSON.stringify(rating.blockIds ?? []),
							},
						})
						.run(),
				catch: (e) =>
					new ReviewError({ message: `Failed to save walkthrough rating: ${String(e)}` }),
			});
		}),

	getCached: (prId, headSha) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;

			const row = db
				.select()
				.from(walkthroughs)
				.where(
					and(
						eq(walkthroughs.pullRequestId, prId),
						eq(walkthroughs.prHeadSha, headSha),
						eq(walkthroughs.status, 'complete'),
					),
				)
				.get();

			if (!row) return null;

			const blocks = db
				.select()
				.from(walkthroughBlocks)
				.where(eq(walkthroughBlocks.walkthroughId, row.id))
				.all();

			const issues = db
				.select()
				.from(walkthroughIssues)
				.where(eq(walkthroughIssues.walkthroughId, row.id))
				.all();

			const ratings = db
				.select()
				.from(walkthroughRatings)
				.where(eq(walkthroughRatings.walkthroughId, row.id))
				.all();

			return rowToWalkthrough(row, blocks, issues, ratings);
		}),

	getPartial: (prId, headSha) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;

			const row = db
				.select()
				.from(walkthroughs)
				.where(
					and(
						eq(walkthroughs.pullRequestId, prId),
						eq(walkthroughs.prHeadSha, headSha),
						ne(walkthroughs.status, 'complete'),
					),
				)
				.get();

			if (!row) return null;

			const blocks = db
				.select()
				.from(walkthroughBlocks)
				.where(eq(walkthroughBlocks.walkthroughId, row.id))
				.all();

			const issues = db
				.select()
				.from(walkthroughIssues)
				.where(eq(walkthroughIssues.walkthroughId, row.id))
				.all();

			const ratings = db
				.select()
				.from(walkthroughRatings)
				.where(eq(walkthroughRatings.walkthroughId, row.id))
				.all();

			return {
				...rowToWalkthrough(row, blocks, issues, ratings),
				status: row.status as 'generating' | 'error',
				opencodeSessionId: row.opencodeSessionId ?? null,
			};
		}),

	invalidateForPr: (prId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			// walkthrough_blocks, walkthrough_issues, and walkthrough_ratings
			// rows are all cascade-deleted via their FK → walkthroughs.id.
			db
				.delete(walkthroughs)
				.where(eq(walkthroughs.pullRequestId, prId))
				.run();
		}),

	setOpencodeSessionId: (walkthroughId, sessionId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			db
				.update(walkthroughs)
				.set({ opencodeSessionId: sessionId })
				.where(eq(walkthroughs.id, walkthroughId))
				.run();
		}).pipe(Effect.catchAll(() => Effect.void)),

	setPendingCarriedOver: (prId, issues) =>
		Effect.sync(() => {
			pendingCarriedOverMap.set(prId, issues);
		}),

	consumePendingCarriedOver: (prId) =>
		Effect.sync(() => {
			const issues = pendingCarriedOverMap.get(prId) ?? [];
			pendingCarriedOverMap.delete(prId);
			return issues;
		}),
});
