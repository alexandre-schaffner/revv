import { Elysia } from 'elysia';
import { Effect } from 'effect';
import type { Repository } from '@rev/shared';
import { auth } from '../auth';
import { AppRuntime } from '../runtime';
import { GitHubService } from '../services/GitHub';

/** Simple in-memory cache for the user's GitHub repos. */
let repoCache: { data: Repository[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const githubRoutes = new Elysia({ prefix: '/api/github' }).get(
	'/repos',
	async (ctx) => {
		const session = await auth.api.getSession({ headers: ctx.request.headers });
		if (!session) {
			ctx.set.status = 401;
			return { error: 'Unauthorized' };
		}

		const force = ctx.query['force'] === 'true';

		if (!force && repoCache && Date.now() - repoCache.fetchedAt < CACHE_TTL_MS) {
			return repoCache.data;
		}

		const repos = await AppRuntime.runPromise(
			Effect.gen(function* () {
				const github = yield* GitHubService;

				const token = yield* Effect.tryPromise({
					try: async () => {
						const result = await auth.api.getAccessToken({
							body: { providerId: 'github', userId: session.user.id },
						});
						return result?.accessToken ?? '';
					},
					catch: () => null as unknown,
				}).pipe(Effect.orElseSucceed(() => ''));

				return yield* github.listUserRepos(token as string);
			})
		);

		repoCache = { data: repos, fetchedAt: Date.now() };
		return repos;
	}
);
