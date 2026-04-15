import { Elysia, t } from 'elysia';
import { Effect } from 'effect';
import { auth } from '../auth';
import { AppRuntime } from '../runtime';
import { PollScheduler } from '../services/PollScheduler';
import { PullRequestService } from '../services/PullRequest';
import { RepositoryService } from '../services/Repository';
import { TokenProvider } from '../services/TokenProvider';
import { GitHubService } from '../services/GitHub';

// ── Routes ───────────────────────────────────────────────────────────────────

export const prRoutes = new Elysia({ prefix: '/api/prs' })
	.get(
		'/',
		async (ctx) => {
			const session = await auth.api.getSession({ headers: ctx.request.headers });
			if (!session) {
				ctx.set.status = 401;
				return { error: 'Unauthorized' };
			}

			const repoId = ctx.query.repo;
			return AppRuntime.runPromise(
				Effect.flatMap(PullRequestService, (s) => s.listPrs(repoId))
			);
		},
		{ query: t.Object({ repo: t.Optional(t.String()) }) }
	)
	.get('/:id', async (ctx) => {
		const session = await auth.api.getSession({ headers: ctx.request.headers });
		if (!session) {
			ctx.set.status = 401;
			return { error: 'Unauthorized' };
		}

		try {
			return await AppRuntime.runPromise(
				Effect.flatMap(PullRequestService, (s) => s.getPr(ctx.params.id))
			);
		} catch (e) {
			if (e && typeof e === 'object' && '_tag' in e && (e as {_tag: string})._tag === 'NotFoundError') {
				ctx.set.status = 404;
				return { error: 'PR not found' };
			}
			throw e;
		}
	})
	.get('/:id/files', async (ctx) => {
		const session = await auth.api.getSession({ headers: ctx.request.headers });
		if (!session) {
			ctx.set.status = 401;
			return { error: 'Unauthorized' };
		}

		try {
			return await AppRuntime.runPromise(
				Effect.gen(function* () {
					const prService = yield* PullRequestService;
					const repoService = yield* RepositoryService;
					const tokenProvider = yield* TokenProvider;
					const github = yield* GitHubService;

					// Resolve PR → repo → token
					const pr = yield* prService.getPr(ctx.params.id);
					const repo = yield* repoService.getRepoById(pr.repositoryId);
					const token = yield* tokenProvider.getGitHubToken(session.user.id);

					// Fetch file list — the GitHub API returns the patch
					// (unified diff) for each file, so no per-file content
					// fetches are needed.
					const fileList = yield* github.getPrFiles(
						repo.fullName,
						pr.externalId,
						token
					);

					return fileList.map((f) => ({
						path: f.filename,
						oldPath: f.previousFilename,
						patch: f.patch,
						additions: f.additions,
						deletions: f.deletions,
						isNew: f.status === 'added',
						isDeleted: f.status === 'removed',
					}));
				})
			);
		} catch (e) {
			if (e && typeof e === 'object' && '_tag' in e) {
				const tagged = e as { _tag: string };
				if (tagged._tag === 'NotFoundError') {
					ctx.set.status = 404;
					return { error: 'PR not found' };
				}
				if (tagged._tag === 'GitHubAuthError') {
					ctx.set.status = 401;
					return { error: 'GitHub token expired or invalid' };
				}
			}
			ctx.set.status = 502;
			return { error: 'Failed to fetch PR files from GitHub' };
		}
	})
	.post('/sync', async (ctx) => {
		const session = await auth.api.getSession({ headers: ctx.request.headers });
		if (!session) {
			ctx.set.status = 401;
			return { error: 'Unauthorized' };
		}

		await AppRuntime.runPromise(
			Effect.flatMap(PollScheduler, (s) => s.syncNow())
		);

		return { success: true };
	});
