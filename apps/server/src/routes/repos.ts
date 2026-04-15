import { Elysia, t } from 'elysia';
import { Effect } from 'effect';
import { auth } from '../auth';
import { AppRuntime } from '../runtime';
import { GitHubService } from '../services/GitHub';
import { PollScheduler } from '../services/PollScheduler';
import { RepositoryService } from '../services/Repository';

export const repoRoutes = new Elysia({ prefix: '/api/repos' })
	.get('/', async (ctx) => {
		const session = await auth.api.getSession({ headers: ctx.request.headers });
		if (!session) {
			ctx.set.status = 401;
			return { error: 'Unauthorized' };
		}

		return AppRuntime.runPromise(
			Effect.flatMap(RepositoryService, (s) => s.listRepos())
		);
	})
	.post(
		'/',
		async (ctx) => {
			const session = await auth.api.getSession({ headers: ctx.request.headers });
			if (!session) {
				ctx.set.status = 401;
				return { error: 'Unauthorized' };
			}

			const { fullName } = ctx.body;

			return AppRuntime.runPromise(
				Effect.gen(function* () {
					const github = yield* GitHubService;
					const repoSvc = yield* RepositoryService;
					const scheduler = yield* PollScheduler;

					// Validate repo exists on GitHub using a placeholder token
					// (In production, get the user's token from Better Auth)
					const token = yield* Effect.tryPromise({
						try: async () => {
							const result = await auth.api.getAccessToken({
								body: { providerId: 'github', userId: session.user.id },
							});
							return result?.accessToken ?? '';
						},
						catch: () => null as unknown,
					}).pipe(Effect.orElseSucceed(() => ''));

					const repoData = yield* github.getRepo(fullName, token as string);
					const saved = yield* repoSvc.addRepo(repoData);

					// Trigger a sync in the background
					yield* Effect.fork(scheduler.syncNow());

					return saved;
				})
			);
		},
		{ body: t.Object({ fullName: t.String() }) }
	)
	.delete('/:id', async (ctx) => {
		const session = await auth.api.getSession({ headers: ctx.request.headers });
		if (!session) {
			ctx.set.status = 401;
			return { error: 'Unauthorized' };
		}

		try {
			await AppRuntime.runPromise(
				Effect.flatMap(RepositoryService, (s) => s.deleteRepo(ctx.params.id))
			);
		} catch (e) {
			if (e && typeof e === 'object' && '_tag' in e && (e as {_tag: string})._tag === 'NotFoundError') {
				ctx.set.status = 404;
				return { error: 'Repository not found' };
			}
			throw e;
		}

		return { success: true };
	});
