import { Context, Effect, Layer } from 'effect';
import { auth } from '../auth';
import { DbService } from './Db';
import { GitHubAuthError } from '../domain/errors';
import { user } from '../db/schema';

export class TokenProvider extends Context.Tag('TokenProvider')<
	TokenProvider,
	{
		readonly getGitHubToken: (userId: string) => Effect.Effect<string, GitHubAuthError>;
	}
>() {}

export const TokenProviderLive = Layer.effect(
	TokenProvider,
	Effect.gen(function* () {
		const { db } = yield* DbService;

		return {
			getGitHubToken: (userId: string) =>
				Effect.tryPromise({
					try: async () => {
						// 'single-user' is a placeholder — resolve to the actual user ID
						let resolvedId = userId;
						if (userId === 'single-user' || !userId) {
							const rows = await db.select({ id: user.id }).from(user).limit(1);
							const firstRow = rows[0];
							if (!firstRow) throw new Error('No user found');
							resolvedId = firstRow.id;
						}
						const result = await auth.api.getAccessToken({
							body: { providerId: 'github', userId: resolvedId },
						});
						if (!result?.accessToken) throw new Error('No access token found');
						return result.accessToken;
					},
					catch: (e) => new GitHubAuthError({ message: String(e) }),
				}),
		};
	})
);
