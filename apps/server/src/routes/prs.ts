import { Elysia, t } from 'elysia';
import { Effect } from 'effect';
import { eq } from 'drizzle-orm';
import { AppRuntime } from '../runtime';
import { db } from '../auth';
import { user } from '../db/schema';
import { PollScheduler } from '../services/PollScheduler';
import { PrContextService } from '../services/PrContext';
import { PullRequestService } from '../services/PullRequest';
import { RepositoryService } from '../services/Repository';
import { RepoCloneService } from '../services/RepoClone';
import { SyncService } from '../services/Sync';
import { TokenProvider } from '../services/TokenProvider';
import { getOrFetchDiffFiles } from '../services/DiffCache';
import { GitHubService } from '../services/GitHub';
import { WebSocketHub } from '../services/WebSocketHub';
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
	})

	// ── Owner-only PR mutations (draft toggle, close) ─────────────────────
	//
	// All three endpoints follow the same shape: resolve PR + repo + token,
	// run the GitHub mutation, refresh the local row from a fresh GET, and
	// broadcast `prs:updated` so other clients see the new state without
	// waiting for the next poll cycle.
	.post('/:id/convert-to-draft', async (ctx) => {
		try {
			await AppRuntime.runPromise(mutatePr(ctx.params.id, ctx.session.user.id, 'convert-to-draft'));
			return { success: true };
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})
	.post('/:id/ready-for-review', async (ctx) => {
		try {
			await AppRuntime.runPromise(mutatePr(ctx.params.id, ctx.session.user.id, 'ready-for-review'));
			return { success: true };
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})
	.post('/:id/close', async (ctx) => {
		try {
			await AppRuntime.runPromise(mutatePr(ctx.params.id, ctx.session.user.id, 'close'));
			return { success: true };
		} catch (e) {
			return handleAppError(e, ctx);
		}
	});

type PrMutationAction = 'convert-to-draft' | 'ready-for-review' | 'close';

/**
 * Shared executor for the three owner-only PR mutations above. Each one is
 * a thin wrapper over a single GitHubService call, so the
 * resolve → mutate → refresh-row → broadcast scaffolding is identical and
 * lifted here.
 */
function mutatePr(prId: string, userId: string, action: PrMutationAction) {
	return Effect.gen(function* () {
		const prContext = yield* PrContextService;
		const github = yield* GitHubService;
		const prService = yield* PullRequestService;
		const hub = yield* WebSocketHub;

		const { pr, repo, token } = yield* prContext.resolveBasic(prId, userId);

		if (action === 'convert-to-draft') {
			yield* github.convertPrToDraft(repo.fullName, pr.externalId, token);
		} else if (action === 'ready-for-review') {
			yield* github.markPrReadyForReview(repo.fullName, pr.externalId, token);
		} else {
			yield* github.closePullRequest(repo.fullName, pr.externalId, token);
		}

		// Refresh from a fresh GET so isDraft / status reflect GitHub's new
		// state — the mutation responses don't return the full PR shape we
		// store, and the conditional cache would otherwise replay the
		// pre-mutation body on the next read.
		const refreshed = yield* github
			.getPr(repo.fullName, pr.externalId, token)
			.pipe(Effect.map((p) => ({ ...p, id: pr.id, repositoryId: pr.repositoryId })));
		yield* prService.upsertPrs([refreshed]);

		const all = yield* prService.listPrs();
		yield* hub.broadcast({ type: 'prs:updated', data: all });
	});
}
