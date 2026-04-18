import { Context, Effect, Layer } from 'effect';
import { eq, inArray } from 'drizzle-orm';
import type { PullRequest } from '@revv/shared';
import { NotFoundError, ValidationError } from '../domain/errors';
import { pullRequests } from '../db/schema/index';
import { DbService } from './Db';

function rowToPr(row: typeof pullRequests.$inferSelect): PullRequest {
	return {
		id: row.id,
		externalId: row.externalId,
		repositoryId: row.repositoryId,
		title: row.title,
		body: row.body ?? null,
		authorLogin: row.authorLogin,
		authorAvatarUrl: row.authorAvatarUrl ?? null,
		requestedReviewers: JSON.parse(row.requestedReviewers ?? '[]') as string[],
		status: row.status as PullRequest['status'],
		reviewStatus: row.reviewStatus as PullRequest['reviewStatus'],
		sourceBranch: row.sourceBranch,
		targetBranch: row.targetBranch,
		url: row.url,
		additions: row.additions,
		deletions: row.deletions,
		changedFiles: row.changedFiles,
		headSha: row.headSha ?? null,
		baseSha: row.baseSha ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		fetchedAt: row.fetchedAt,
	};
}

export class PullRequestService extends Context.Tag('PullRequestService')<
	PullRequestService,
	{
		readonly listPrs: (repoId?: string) => Effect.Effect<PullRequest[], never, DbService>;
		readonly getPr: (id: string) => Effect.Effect<PullRequest, NotFoundError, DbService>;
		readonly upsertPrs: (prs: PullRequest[]) => Effect.Effect<void, ValidationError, DbService>;
		readonly deletePrs: (ids: string[]) => Effect.Effect<void, ValidationError, DbService>;
		/**
		 * Read the high-water-mark for review-comment sync. Used as the `?since=`
		 * parameter on the next poll so we don't re-download comments we've
		 * already ingested. Null on a cache cold-start.
		 */
		readonly getCommentsSyncedAt: (
			prId: string,
		) => Effect.Effect<string | null, never, DbService>;
		/** Persist the watermark after a successful sync. */
		readonly setCommentsSyncedAt: (
			prId: string,
			timestamp: string,
		) => Effect.Effect<void, never, DbService>;
		/**
		 * Read the GraphQL-thread fingerprint for a PR. Used to skip redundant
		 * downstream DB writes and WS events when nothing changed on GitHub.
		 * Null = fingerprint has never been computed for this PR.
		 */
		readonly getThreadsFingerprint: (
			prId: string,
		) => Effect.Effect<string | null, never, DbService>;
		/** Store a new threads fingerprint after each GraphQL pull. */
		readonly setThreadsFingerprint: (
			prId: string,
			fingerprint: string,
		) => Effect.Effect<void, never, DbService>;
	}
>() {}

export const PullRequestServiceLive = Layer.succeed(PullRequestService, {
	listPrs: (repoId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const rows = repoId
				? db.select().from(pullRequests).where(eq(pullRequests.repositoryId, repoId)).all()
				: db.select().from(pullRequests).all();
			return rows.map(rowToPr);
		}),

	getPr: (id) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const row = db.select().from(pullRequests).where(eq(pullRequests.id, id)).get();
			if (!row) {
				return yield* Effect.fail(new NotFoundError({ resource: 'pull_request', id }));
			}
			return rowToPr(row);
		}),

	upsertPrs: (prs) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			if (prs.length === 0) return;
			yield* Effect.tryPromise({
				try: () => {
					const values = prs.map((pr) => {
						const base: typeof pullRequests.$inferInsert = {
							id: pr.id,
							externalId: pr.externalId,
							repositoryId: pr.repositoryId,
							title: pr.title,
							authorLogin: pr.authorLogin,
							status: pr.status,
							reviewStatus: pr.reviewStatus,
							sourceBranch: pr.sourceBranch,
							targetBranch: pr.targetBranch,
							url: pr.url,
							additions: pr.additions,
							deletions: pr.deletions,
							changedFiles: pr.changedFiles,
							createdAt: pr.createdAt,
							updatedAt: pr.updatedAt,
					fetchedAt: pr.fetchedAt,
						requestedReviewers: JSON.stringify(pr.requestedReviewers ?? []),
					};
					// Only set optional fields when non-null to satisfy exactOptionalPropertyTypes
					if (pr.body !== null) base.body = pr.body;
					if (pr.authorAvatarUrl !== null) base.authorAvatarUrl = pr.authorAvatarUrl;
					if (pr.headSha !== null) base.headSha = pr.headSha;
					if (pr.baseSha !== null) base.baseSha = pr.baseSha;
						return base;
					});
					return Promise.resolve(
						db
							.insert(pullRequests)
							.values(values)
							.onConflictDoUpdate({
								target: pullRequests.id,
								set: {
									title: pullRequests.title,
									body: pullRequests.body,
									status: pullRequests.status,
									additions: pullRequests.additions,
									deletions: pullRequests.deletions,
									changedFiles: pullRequests.changedFiles,
									headSha: pullRequests.headSha,
									baseSha: pullRequests.baseSha,
								updatedAt: pullRequests.updatedAt,
								fetchedAt: pullRequests.fetchedAt,
								requestedReviewers: pullRequests.requestedReviewers,
							},
							})
							.run()
					);
				},
				catch: (e) => new ValidationError({ message: String(e) }),
			});
		}),

	deletePrs: (ids) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			if (ids.length === 0) return;
			yield* Effect.tryPromise({
				try: () =>
					Promise.resolve(
						db.delete(pullRequests).where(inArray(pullRequests.id, ids)).run()
					),
				catch: (e) => new ValidationError({ message: String(e) }),
			});
		}),

	getCommentsSyncedAt: (prId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const row = db
				.select({ ts: pullRequests.commentsSyncedAt })
				.from(pullRequests)
				.where(eq(pullRequests.id, prId))
				.get();
			return row?.ts ?? null;
		}),

	setCommentsSyncedAt: (prId, timestamp) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			db.update(pullRequests)
				.set({ commentsSyncedAt: timestamp })
				.where(eq(pullRequests.id, prId))
				.run();
		}),

	getThreadsFingerprint: (prId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const row = db
				.select({ fp: pullRequests.threadsFingerprint })
				.from(pullRequests)
				.where(eq(pullRequests.id, prId))
				.get();
			return row?.fp ?? null;
		}),

	setThreadsFingerprint: (prId, fingerprint) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			db.update(pullRequests)
				.set({ threadsFingerprint: fingerprint })
				.where(eq(pullRequests.id, prId))
				.run();
		}),
});
