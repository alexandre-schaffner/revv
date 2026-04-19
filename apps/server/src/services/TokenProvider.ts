import { Context, Effect, Layer } from 'effect';
import { and, eq } from 'drizzle-orm';
import { DbService } from './Db';
import { GitHubAuthError } from '../domain/errors';
import { user, account } from '../db/schema';

/**
 * Fetches the GitHub access token stored on the user's linked GitHub account.
 *
 * We read from the `account` table directly rather than going through
 * `better-auth`'s `getAccessToken` API because Revv's only auth path is the
 * device-code flow (see `routes/device-auth.ts`), which writes the token to
 * this table itself. Keeping the dependency local also means we don't need
 * better-auth's `socialProviders.github` to be configured — which it no
 * longer is, since `client_secret` was removed.
 */
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
						const rows = await db
							.select({ accessToken: account.accessToken })
							.from(account)
							.where(and(eq(account.userId, resolvedId), eq(account.providerId, 'github')))
							.limit(1);
						const token = rows[0]?.accessToken;
						if (!token) throw new Error('No access token found');
						return token;
					},
					catch: (e) => new GitHubAuthError({ message: String(e) }),
				}),
		};
	})
);
