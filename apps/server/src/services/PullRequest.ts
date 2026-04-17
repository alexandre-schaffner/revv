import { Context, Effect, Layer } from 'effect';
import { eq } from 'drizzle-orm';
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
								},
							})
							.run()
					);
				},
				catch: (e) => new ValidationError({ message: String(e) }),
			});
		}),
});
