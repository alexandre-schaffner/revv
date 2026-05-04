import { Elysia, t } from 'elysia';
import { Effect } from 'effect';
import { eq } from 'drizzle-orm';
import { AppRuntime } from '../runtime';
import { db } from '../auth';
import { user } from '../db/schema';
import { PollScheduler } from '../services/PollScheduler';
import { PullRequestService } from '../services/PullRequest';
import { RepositoryService } from '../services/Repository';
import { RepoCloneService } from '../services/RepoClone';
import { SyncService } from '../services/Sync';
import { TokenProvider } from '../services/TokenProvider';
import { getOrFetchDiffFiles } from '../services/DiffCache';
import { GitHubService } from '../services/GitHub';
import { withAuth, handleAppError } from './middleware';

// ── Routes ───────────────────────────────────────────────────────────────────

export const prRoutes = new Elysia({ prefix: '/api/prs' })
	.use(withAuth)
	.get(
		'/',
		async (ctx) => {
			try {
				const repoId = ctx.query.repo;
				return await AppRuntime.runPromise(
					Effect.flatMap(PullRequestService, (s) => s.listPrs(repoId))
				);
			} catch (e) {
				return handleAppError(e, ctx);
			}
		},
		{ query: t.Object({ repo: t.Optional(t.String()) }) }
	)
	.get('/:id', async (ctx) => {
		try {
			return await AppRuntime.runPromise(
				Effect.flatMap(PullRequestService, (s) => s.getPr(ctx.params.id))
			);
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})
	.get('/:id/files', async (ctx) => {
		try {
			return await AppRuntime.runPromise(
				Effect.gen(function* () {
					const prService = yield* PullRequestService;
					const repoService = yield* RepositoryService;
					const tokenProvider = yield* TokenProvider;

					const pr = yield* prService.getPr(ctx.params.id);
					const repo = yield* repoService.getRepoById(pr.repositoryId);

					// Always the full PR diff (merge-base 3-dot, matching GitHub's
					// "Files changed" tab). No per-commit selection anymore — the
					// commits dropdown is read-only.
					const token = yield* tokenProvider.getGitHubToken(ctx.session.user.id);
					const files = yield* getOrFetchDiffFiles(
						pr.id,
						repo.fullName,
						pr.externalId,
						token
					);

					return files.map((f) => ({
						path: f.path,
						oldPath: f.oldPath,
						patch: f.patch,
						additions: f.additions,
						deletions: f.deletions,
						isNew: f.status === 'added',
						isDeleted: f.status === 'removed',
					}));
				})
			);
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})
	.get(
			'/:id/repo-file',
			async (ctx) => {
				try {
					return await AppRuntime.runPromise(
						Effect.gen(function* () {
							const prService = yield* PullRequestService;
							const repoCloneService = yield* RepoCloneService;

							const pr = yield* prService.getPr(ctx.params.id);
							if (!pr.headSha) {
								ctx.set.status = 404;
								return {
									status: 'error' as const,
									message: 'PR has no head SHA',
								};
							}

							const result = yield* repoCloneService.getFileContentAtSha(
								pr.repositoryId,
								pr.headSha,
								ctx.query.path,
							);

							if (result.status === 'cloning') {
								ctx.set.status = 202;
								return { status: 'cloning' as const };
							}
							if (result.status === 'not-found') {
								ctx.set.status = 404;
								return { status: 'not-found' as const };
							}
							if (result.status === 'too-large') {
								// 413 Payload Too Large — surfaces a distinct
								// frontend state ("file too large to preview")
								// without conflating with cloning/missing.
								ctx.set.status = 413;
								return {
									status: 'too-large' as const,
									size: result.size,
								};
							}
							if (result.status === 'error') {
								ctx.set.status = 409;
								return {
									status: 'error' as const,
									message: result.message,
								};
							}

							return {
								status: 'ready' as const,
								headSha: pr.headSha,
								path: ctx.query.path,
								content: result.content,
								isBinary: result.isBinary,
								size: result.size,
							};
						}),
					);
				} catch (e) {
					return handleAppError(e, ctx);
				}
			},
			{ query: t.Object({ path: t.String() }) },
		)
	.get('/:id/repo-tree', async (ctx) => {
			try {
				return await AppRuntime.runPromise(
					Effect.gen(function* () {
						const prService = yield* PullRequestService;
						const repoCloneService = yield* RepoCloneService;
						const tokenProvider = yield* TokenProvider;

						const pr = yield* prService.getPr(ctx.params.id);
						if (!pr.headSha) {
							ctx.set.status = 404;
							return { status: 'error' as const, message: 'PR has no head SHA' };
						}

						const token = yield* tokenProvider.getGitHubToken(ctx.session.user.id);
						const result = yield* repoCloneService.listFilesAtSha(
							pr.repositoryId,
							pr.externalId,
							pr.headSha,
							token,
						);

						if (result.status === 'cloning') {
							ctx.set.status = 202;
							return { status: 'cloning' as const };
						}
						if (result.status === 'error') {
							ctx.set.status = 409;
							return { status: 'error' as const, message: result.message };
						}
						return {
							status: 'ready' as const,
							headSha: pr.headSha,
							paths: result.paths,
						};
					})
				);
			} catch (e) {
				return handleAppError(e, ctx);
			}
		})
	.post('/sync', async (ctx) => {
		try {
			await AppRuntime.runPromise(
				Effect.flatMap(PollScheduler, (s) => s.syncNow())
			);

			return { success: true };
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})

	.get('/:id/commits', async (ctx) => {
		try {
			return await AppRuntime.runPromise(
				Effect.gen(function* () {
					const prService = yield* PullRequestService;
					const repoService = yield* RepositoryService;
					const tokenProvider = yield* TokenProvider;
					const githubService = yield* GitHubService;

					const pr = yield* prService.getPr(ctx.params.id);
					const repo = yield* repoService.getRepoById(pr.repositoryId);
					const token = yield* tokenProvider.getGitHubToken(ctx.session.user.id);

					return yield* githubService.listPrCommits(repo.fullName, pr.externalId, token);
				})
			);
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})

	.post('/:id/sync-threads', async (ctx) => {
		try {
			return await AppRuntime.runPromise(
				Effect.flatMap(SyncService, (s) => s.syncThreads(ctx.params.id))
			);
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})

	.get('/:id/thread-summary', async (ctx) => {
		try {
			// Look up the current user's GitHub login for role-aware counts.
			const rows = await db
				.select({ githubLogin: user.githubLogin })
				.from(user)
				.where(eq(user.id, ctx.session.user.id));
			const login = rows[0]?.githubLogin ?? null;

			return await AppRuntime.runPromise(
				Effect.flatMap(SyncService, (s) => s.getThreadSummary(ctx.params.id, login))
			);
		} catch (e) {
			return handleAppError(e, ctx);
		}
	});
