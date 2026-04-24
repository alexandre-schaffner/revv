// ─── WalkthroughService ──────────────────────────────────────────────────────
//
// Thin DB adapter for the walkthroughs tables. Scope is deliberately narrow
// post-refactor:
//
//   • ORCHESTRATOR LIFECYCLE writes (per doctrine invariant #2 + #11):
//     - createPartial    (inserts the row when a job begins)
//     - setStatus        (generating → complete | error | superseded)
//     - supersede        (old row → superseded, links to new row)
//     - setOpencodeSessionId (opencode continuation id)
//     - incrementResumeAttempts (resume counter)
//     - markIssuesSubmitted (GitHub push bookkeeping)
//
//   • READ-SIDE:
//     - getCached
//     - getPartial
//     - listGenerating
//
// Content writes (summary/risk, diff steps, issues, ratings, sentiment) are
// NOT here — they live inside MCP tool handlers in walkthrough-tools.ts, per
// doctrine invariant #2 ("agent content writes go through MCP, only"). Any
// method that used to synthesize content on behalf of an agent is gone.

import { Context, Effect, Layer } from 'effect';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type {
	Walkthrough,
	WalkthroughBlock,
	WalkthroughIssue,
	WalkthroughPipelinePhase,
	WalkthroughRating,
	WalkthroughStatus,
	WalkthroughTokenUsage,
	RatingAxis,
	RatingCitation,
	Verdict,
	Confidence,
	RiskLevel,
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
				...(i.submittedAt !== null ? { submittedAt: i.submittedAt } : {}),
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
		sentiment: row.sentiment ?? null,
		blocks: sortedBlocks,
		issues: sortedIssues,
		ratings: sortedRatings,
		lastCompletedPhase: row.lastCompletedPhase as WalkthroughPipelinePhase,
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
		/**
		 * Insert a new walkthrough row at start of generation. Idempotent: if a
		 * row with `(prId, prHeadSha)` already exists, returns its id (enforced
		 * by UNIQUE INDEX walkthroughs_pr_head_sha_unique). This is the sole
		 * "start a walkthrough" insert path — the agent never creates its own
		 * row, it only mutates the row the orchestrator created.
		 *
		 * The row is inserted with empty summary/riskLevel and
		 * lastCompletedPhase='none'. Phase A (set_overview) fills the overview.
		 */
		readonly createPartial: (params: {
			id?: string;
			reviewSessionId: string;
			prId: string;
			modelUsed: string;
			prHeadSha: string;
		}) => Effect.Effect<string, ReviewError, DbService>;

		/**
		 * Set `walkthroughs.status`. The ONLY caller is {@link WalkthroughJobs};
		 * every other module that needs to transition lifecycle goes through
		 * the orchestrator (doctrine invariant #11).
		 */
		readonly setStatus: (
			walkthroughId: string,
			status: WalkthroughStatus,
			options?: { tokenUsage?: WalkthroughTokenUsage },
		) => Effect.Effect<void, never, DbService>;

		/**
		 * Atomically mark `oldId` as `'superseded'` with `supersededBy = newId`.
		 * Called by {@link WalkthroughJobs.supersedeWalkthrough} when the PR
		 * gets a new head SHA. Per doctrine invariant #7, walkthroughs are
		 * immutable per head SHA — a new commit produces a new row, never
		 * mutates the old.
		 */
		readonly supersede: (
			oldId: string,
			newId: string,
		) => Effect.Effect<void, never, DbService>;

		/**
		 * Mark all non-superseded walkthroughs for a PR as 'superseded'.
		 * `supersededBy` is left NULL — it gets backfilled when a new
		 * walkthrough row is subsequently created for the PR's new head SHA,
		 * or stays NULL if no new walkthrough is ever generated. Called by
		 * {@link WalkthroughJobs.supersedeForPr} in response to a detected
		 * head-SHA change.
		 */
		readonly supersedeAllForPr: (
			prId: string,
		) => Effect.Effect<void, never, DbService>;

		/** Get a complete (cached) walkthrough by PR + sha. */
		readonly getCached: (
			prId: string,
			headSha: string,
		) => Effect.Effect<Walkthrough | null, never, DbService>;

		/**
		 * Get an incomplete (generating/error) walkthrough + its blocks for resume.
		 * Superseded rows are NOT returned — they're terminal from the job's perspective.
		 */
		readonly getPartial: (
			prId: string,
			headSha: string,
		) => Effect.Effect<
			(Walkthrough & {
				status: 'generating' | 'error';
				opencodeSessionId: string | null;
			}) | null,
			never,
			DbService
		>;

		readonly invalidateForPr: (
			prId: string,
		) => Effect.Effect<void, never, DbService>;

		/** Persist the opencode session ID for resumption. */
		readonly setOpencodeSessionId: (
			walkthroughId: string,
			sessionId: string,
		) => Effect.Effect<void, never, DbService>;

		/**
		 * List all walkthroughs still in `status='generating'`. Used on server boot
		 * to find rows stranded by a previous crash/restart so {@link WalkthroughJobs}
		 * can re-launch their generators.
		 */
		readonly listGenerating: () => Effect.Effect<
			Array<{
				readonly id: string;
				readonly pullRequestId: string;
				readonly prHeadSha: string;
				readonly opencodeSessionId: string | null;
				readonly resumeAttempts: number;
			}>,
			never,
			DbService
		>;

		/**
		 * Bump the row's resume counter. Returns the new value so the caller can
		 * compare against `WALKTHROUGH_MAX_RESUME_ATTEMPTS` and give up cleanly.
		 * Swallows DB errors — a failed bump falls back to 0 which is treated as
		 * "still worth trying" by the caller.
		 */
		readonly incrementResumeAttempts: (
			walkthroughId: string,
		) => Effect.Effect<number, never, DbService>;

		/**
		 * Stamp the given issue ids with `submittedAt` so the UI's "already
		 * posted to GitHub" state survives app restarts and PR-switches. Unknown
		 * ids are silently ignored — they might have been wiped by a regenerate
		 * between the reviewer opening the tab and clicking Submit. Returns the
		 * timestamp that was written so the caller can echo it back to the
		 * client for optimistic local state.
		 */
		readonly markIssuesSubmitted: (
			issueIds: readonly string[],
		) => Effect.Effect<string, never, DbService>;
	}
>() {}

// ── Live implementation ─────────────────────────────────────────────────────

export const WalkthroughServiceLive = Layer.succeed(WalkthroughService, {
	createPartial: (params) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const id = params.id ?? crypto.randomUUID();
			const generatedAt = new Date().toISOString();

			// onConflictDoNothing on the (prId, prHeadSha) unique index makes
			// this idempotent — a second concurrent startJob returns the
			// existing id (see `.get()` fallback below).
			yield* Effect.try({
				try: () =>
					db
						.insert(walkthroughs)
						.values({
							id,
							reviewSessionId: params.reviewSessionId,
							pullRequestId: params.prId,
							summary: '',
							riskLevel: 'low',
							sentiment: null,
							status: 'generating',
							lastCompletedPhase: 'none',
							generatedAt,
							modelUsed: params.modelUsed,
							tokenUsage: '{}',
							prHeadSha: params.prHeadSha,
							resumeAttempts: 0,
						})
						.onConflictDoNothing({
							target: [
								walkthroughs.pullRequestId,
								walkthroughs.prHeadSha,
							],
						})
						.run(),
				catch: (e) =>
					new ReviewError({
						message: `Failed to create walkthrough: ${String(e)}`,
					}),
			});

			// If an existing row preempted our insert, return ITS id. The
			// uniqueness is on (prId, prHeadSha), so the row we'd have inserted
			// is interchangeable with the one already there.
			const existing = db
				.select({ id: walkthroughs.id })
				.from(walkthroughs)
				.where(
					and(
						eq(walkthroughs.pullRequestId, params.prId),
						eq(walkthroughs.prHeadSha, params.prHeadSha),
					),
				)
				.get();

			return existing?.id ?? id;
		}),

	setStatus: (walkthroughId, status, options) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			db.update(walkthroughs)
				.set({
					status,
					...(options?.tokenUsage
						? { tokenUsage: JSON.stringify(options.tokenUsage) }
						: {}),
				})
				.where(eq(walkthroughs.id, walkthroughId))
				.run();
		}).pipe(Effect.catchAll(() => Effect.void)),

	supersede: (oldId, newId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			db.transaction(() => {
				db.update(walkthroughs)
					.set({ status: 'superseded', supersededBy: newId })
					.where(eq(walkthroughs.id, oldId))
					.run();
			});
		}).pipe(Effect.catchAll(() => Effect.void)),

	supersedeAllForPr: (prId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			db.update(walkthroughs)
				.set({ status: 'superseded' })
				.where(
					and(
						eq(walkthroughs.pullRequestId, prId),
						ne(walkthroughs.status, 'superseded'),
					),
				)
				.run();
		}).pipe(Effect.catchAll(() => Effect.void)),

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

			// "Partial" = not yet 'complete' and not 'superseded'. Superseded
			// rows are terminal from a resume perspective — their head_sha is
			// stale and their supersededBy target is the active one.
			const row = db
				.select()
				.from(walkthroughs)
				.where(
					and(
						eq(walkthroughs.pullRequestId, prId),
						eq(walkthroughs.prHeadSha, headSha),
						ne(walkthroughs.status, 'complete'),
						ne(walkthroughs.status, 'superseded'),
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
			db.delete(walkthroughs)
				.where(eq(walkthroughs.pullRequestId, prId))
				.run();
		}),

	setOpencodeSessionId: (walkthroughId, sessionId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			db.update(walkthroughs)
				.set({ opencodeSessionId: sessionId })
				.where(eq(walkthroughs.id, walkthroughId))
				.run();
		}).pipe(Effect.catchAll(() => Effect.void)),

	listGenerating: () =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const rows = db
				.select({
					id: walkthroughs.id,
					pullRequestId: walkthroughs.pullRequestId,
					prHeadSha: walkthroughs.prHeadSha,
					opencodeSessionId: walkthroughs.opencodeSessionId,
					resumeAttempts: walkthroughs.resumeAttempts,
				})
				.from(walkthroughs)
				.where(eq(walkthroughs.status, 'generating'))
				.all();
			return rows.map((r) => ({
				id: r.id,
				pullRequestId: r.pullRequestId,
				prHeadSha: r.prHeadSha,
				opencodeSessionId: r.opencodeSessionId ?? null,
				resumeAttempts: r.resumeAttempts,
			}));
		}),

	incrementResumeAttempts: (walkthroughId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const row = db
				.select({ resumeAttempts: walkthroughs.resumeAttempts })
				.from(walkthroughs)
				.where(eq(walkthroughs.id, walkthroughId))
				.get();
			const next = (row?.resumeAttempts ?? 0) + 1;
			db.update(walkthroughs)
				.set({ resumeAttempts: next })
				.where(eq(walkthroughs.id, walkthroughId))
				.run();
			return next;
		}).pipe(Effect.catchAll(() => Effect.succeed(0))),

	markIssuesSubmitted: (issueIds) =>
		Effect.gen(function* () {
			const submittedAt = new Date().toISOString();
			if (issueIds.length === 0) return submittedAt;
			const { db } = yield* DbService;
			db.update(walkthroughIssues)
				.set({ submittedAt })
				.where(inArray(walkthroughIssues.id, [...issueIds]))
				.run();
			return submittedAt;
		}).pipe(Effect.catchAll(() => Effect.succeed(new Date().toISOString()))),
});
