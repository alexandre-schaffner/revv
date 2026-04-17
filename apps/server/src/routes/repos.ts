import { Elysia, t } from 'elysia';
import { Effect } from 'effect';
import { AppRuntime } from '../runtime';
import { GitHubService } from '../services/GitHub';
import { PollScheduler } from '../services/PollScheduler';
import { RepoCloneService } from '../services/RepoClone';
import { RepositoryService } from '../services/Repository';
import { TokenProvider } from '../services/TokenProvider';
import { withAuth, handleAppError } from './middleware';

export const repoRoutes = new Elysia({ prefix: '/api/repos' })
	.use(withAuth)
	.get('/', async (ctx) => {
		return AppRuntime.runPromise(
			Effect.flatMap(RepositoryService, (s) => s.listRepos())
		);
	})
	.post(
		'/',
		async (ctx) => {
			const { fullName } = ctx.body;

			try {
				return await AppRuntime.runPromise(
					Effect.gen(function* () {
						const github = yield* GitHubService;
						const repoSvc = yield* RepositoryService;
						const scheduler = yield* PollScheduler;
						const tokenProvider = yield* TokenProvider;
						const cloneSvc = yield* RepoCloneService;

						const token = yield* tokenProvider.getGitHubToken(ctx.session.user.id);
						const repoData = yield* github.getRepo(fullName, token);
						const saved = yield* repoSvc.addRepo(repoData);

						// Trigger a sync in the background
						yield* Effect.fork(scheduler.syncNow());

						// Trigger shallow clone in background — fire and forget
						yield* Effect.fork(
							cloneSvc.cloneRepo(saved, token).pipe(
								Effect.catchAll(() => Effect.void) // errors tracked in DB, don't fail the add
							)
						);

						return saved;
					})
				);
			} catch (e) {
				return handleAppError(e, ctx);
			}
		},
		{ body: t.Object({ fullName: t.String() }) }
	)
	.get('/:id/clone-status', async (ctx) => {
		try {
			return await AppRuntime.runPromise(
				Effect.gen(function* () {
					const cloneSvc = yield* RepoCloneService;
					return yield* cloneSvc.getCloneStatus(ctx.params.id);
				})
			);
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})
	.delete('/:id', async (ctx) => {
		try {
			await AppRuntime.runPromise(
				Effect.gen(function* () {
					const cloneSvc = yield* RepoCloneService;
					const repoSvc = yield* RepositoryService;

					// Clean up clone dir first (best effort)
					yield* cloneSvc.deleteClone(ctx.params.id).pipe(
						Effect.catchAll(() => Effect.void)
					);

					// Then delete DB record
					yield* repoSvc.deleteRepo(ctx.params.id);
				})
			);
		} catch (e) {
			return handleAppError(e, ctx);
		}

		return { success: true };
	});
