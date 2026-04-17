import { Context, Effect, Layer } from 'effect';
import { and, eq, ne } from 'drizzle-orm';
import type {
	Walkthrough,
	WalkthroughBlock,
	WalkthroughIssue,
	WalkthroughTokenUsage,
	RiskLevel,
} from '@revv/shared';
import { ReviewError } from '../domain/errors';
import { walkthroughs } from '../db/schema/walkthroughs';
import { walkthroughBlocks } from '../db/schema/walkthrough-blocks';
import { walkthroughIssues } from '../db/schema/walkthrough-issues';
import { DbService } from './Db';

// ── Row-to-domain converter ─────────────────────────────────────────────────

function rowToWalkthrough(
	row: typeof walkthroughs.$inferSelect,
	blocks: Array<typeof walkthroughBlocks.$inferSelect>,
	issues: Array<typeof walkthroughIssues.$inferSelect>,
): Walkthrough {
	const sortedBlocks = [...blocks]
		.sort((a, b) => a.order - b.order)
		.map((b) => JSON.parse(b.data) as WalkthroughBlock);

	const sortedIssues = [...issues]
		.sort((a, b) => a.order - b.order)
		.map((i): WalkthroughIssue => ({
			id: i.id,
			severity: i.severity as WalkthroughIssue['severity'],
			title: i.title,
			description: i.description,
			...(i.filePath !== null ? { filePath: i.filePath } : {}),
			...(i.startLine !== null ? { startLine: i.startLine } : {}),
			...(i.endLine !== null ? { endLine: i.endLine } : {}),
		}));

	return {
		id: row.id,
		reviewSessionId: row.reviewSessionId,
		pullRequestId: row.pullRequestId,
		summary: row.summary,
		blocks: sortedBlocks,
		issues: sortedIssues,
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
		) => Effect.Effect<(Walkthrough & { status: 'generating' | 'error' }) | null, never, DbService>;

		readonly invalidateForPr: (
			prId: string,
		) => Effect.Effect<void, never, DbService>;
	}
>() {}

// ── Live implementation ─────────────────────────────────────────────────────

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
							createdAt: new Date().toISOString(),
						})
						.run(),
				catch: (e) =>
					new ReviewError({ message: `Failed to save walkthrough issue: ${String(e)}` }),
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

			return rowToWalkthrough(row, blocks, issues);
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

			return { ...rowToWalkthrough(row, blocks, issues), status: row.status as 'generating' | 'error' };
		}),

	invalidateForPr: (prId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			// walkthrough_blocks rows are cascade-deleted via FK
			db
				.delete(walkthroughs)
				.where(eq(walkthroughs.pullRequestId, prId))
				.run();
		}),
});
