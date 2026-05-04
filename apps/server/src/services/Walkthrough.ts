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
import { commentThreads } from '../db/schema/comment-threads';
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
		 * Insert a new walkthrough row at start of generation. Behavior depends
		 * on whether a row already exists at `(prId, prHeadSha)`:
		 *
		 *   • no row              → INSERT a fresh row, return its id.
		 *   • row in 'generating' → return the existing id (the in-flight job
		 *                            owns this row; concurrent startJob is
		 *                            idempotent).
		 *   • row in 'complete'   → return the existing id (caller is expected
		 *                            to have hit the cache path first; defensive
		 *                            no-op so we never clobber a finished
		 *                            walkthrough).
		 *   • row in 'superseded' → RECYCLE: delete the stale row (cascades
		 *                            blocks/issues/ratings + AI-authored
		 *                            comment_threads via the issue FK) and
		 *                            insert a fresh row with a new id. This is
		 *                            the regenerate path — the user explicitly
		 *                            asked for a do-over at the same head SHA,
		 *                            so the failed/cancelled prior attempt's
		 *                            content is intentionally cleared.
		 *   • row in 'error'      → RECYCLE: same as superseded. The row is
		 *                            terminal and has no live fiber, so a fresh
		 *                            run replaces it cleanly.
		 *
		 * All-in-one transaction so the lookup + delete + insert can't race a
		 * concurrent startJob for the same (prId, prHeadSha).
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
			const newId = params.id ?? crypto.randomUUID();
			const generatedAt = new Date().toISOString();

			// Atomically: look at any existing row at (prId, prHeadSha), recycle
			// it if it's terminal (superseded/error), otherwise reuse it. The
			// transaction ensures concurrent startJob calls for the same
			// (prId, prHeadSha) can't race the delete-then-insert and produce
			// duplicate rows or zero rows.
			//
			// Cascade chain on DELETE walkthroughs:
			//   walkthrough_blocks   (FK onDelete: cascade)
			//   walkthrough_issues   (FK onDelete: cascade)
			//     └─ comment_threads.walkthrough_issue_id (FK onDelete: cascade)
			//        — drops AI-authored inline comments tied to the failed run
			//   walkthrough_ratings  (FK onDelete: cascade)
			// Other walkthroughs that referenced this row via supersededBy get
			// their pointer NULLed (FK onDelete: set null), which is fine — the
			// audit chain just truncates at the recycled row.
			const result = yield* Effect.try({
				try: () =>
					db.transaction((tx): { id: string } => {
						const existing = tx
							.select({
								id: walkthroughs.id,
								status: walkthroughs.status,
							})
							.from(walkthroughs)
							.where(
								and(
									eq(walkthroughs.pullRequestId, params.prId),
									eq(walkthroughs.prHeadSha, params.prHeadSha),
								),
							)
							.get();

						if (existing) {
							if (
								existing.status === 'generating' ||
								existing.status === 'complete'
							) {
								// In-flight or finished — keep the row. The
								// orchestrator's idempotent-startJob and cache
								// paths upstream of this call already handle
								// these cases; we only reach here on a race.
								return { id: existing.id };
							}
							// 'superseded' or 'error' — drop the row. Cascades
							// clean every child row tied to the prior attempt.
							tx.delete(walkthroughs)
								.where(eq(walkthroughs.id, existing.id))
								.run();
						}

						tx.insert(walkthroughs)
							.values({
								id: newId,
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
							.run();
						return { id: newId };
					}),
				catch: (e) =>
					new ReviewError({
						message: `Failed to create walkthrough: ${String(e)}`,
					}),
			});

			return result.id;
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
				// Drop AI-authored comment threads tied to the outgoing walkthrough's
				// issues. Human threads (walkthroughIssueId IS NULL) are untouched.
				// The walkthroughs row itself is kept for audit (superseded_by chain);
				// we can't rely on the cascade-on-delete path here.
				const issueIds = db
					.select({ id: walkthroughIssues.id })
					.from(walkthroughIssues)
					.where(eq(walkthroughIssues.walkthroughId, oldId))
					.all()
					.map((r) => r.id);
				if (issueIds.length > 0) {
					db.delete(commentThreads)
						.where(inArray(commentThreads.walkthroughIssueId, issueIds))
						.run();
				}
				db.update(walkthroughs)
					.set({ status: 'superseded', supersededBy: newId })
					.where(eq(walkthroughs.id, oldId))
					.run();
			});
		}).pipe(Effect.catchAll(() => Effect.void)),

	supersedeAllForPr: (prId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			db.transaction(() => {
				// Collect the IDs of every walkthrough that is about to be superseded.
				const activeIds = db
					.select({ id: walkthroughs.id })
					.from(walkthroughs)
					.where(
						and(
							eq(walkthroughs.pullRequestId, prId),
							ne(walkthroughs.status, 'superseded'),
						),
					)
					.all()
					.map((r) => r.id);

				if (activeIds.length === 0) return;

				// Drop all AI-authored comment threads linked to those walkthroughs'
				// issues before marking the rows superseded.
				const issueIds = db
					.select({ id: walkthroughIssues.id })
					.from(walkthroughIssues)
					.where(inArray(walkthroughIssues.walkthroughId, activeIds))
					.all()
					.map((r) => r.id);
				if (issueIds.length > 0) {
					db.delete(commentThreads)
						.where(inArray(commentThreads.walkthroughIssueId, issueIds))
						.run();
				}

				db.update(walkthroughs)
					.set({ status: 'superseded' })
					.where(
						and(
							eq(walkthroughs.pullRequestId, prId),
							ne(walkthroughs.status, 'superseded'),
						),
					)
					.run();
			});
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
