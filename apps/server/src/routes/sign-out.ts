import { Elysia } from 'elysia';
import { eq } from 'drizzle-orm';
import { auth, db, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_API_BASE } from '../auth';
import { account } from '../db/schema';
import { logError } from '../logger';
import { withAuth } from './middleware';

/**
 * Revokes the GitHub OAuth token and signs the user out.
 *
 * Flow:
 * 1. Retrieve the stored GitHub access token for the user.
 * 2. Call GitHub's token revocation endpoint (DELETE /applications/{client_id}/token).
 * 3. Clear the access token from the local `account` table.
 * 4. Invalidate the better-auth session.
 *
 * The client should call this instead of the default authClient.signOut().
 */
export const signOutRoute = new Elysia()
	.use(withAuth)
	.post('/api/auth/revoke-and-sign-out', async (ctx) => {
		const userId = ctx.session.user.id;

		// 1. Retrieve the GitHub access token
		let accessToken: string | null = null;
		try {
			const result = await auth.api.getAccessToken({
				body: { providerId: 'github', userId },
			});
			accessToken = result?.accessToken ?? null;
		} catch {
			// Token may already be gone — continue with sign-out
		}

		// 2. Revoke on GitHub
		if (accessToken) {
			try {
				const credentials = btoa(`${GITHUB_CLIENT_ID}:${GITHUB_CLIENT_SECRET}`);
				const res = await fetch(
					`${GITHUB_API_BASE}/applications/${GITHUB_CLIENT_ID}/token`,
					{
						method: 'DELETE',
						headers: {
							Authorization: `Basic ${credentials}`,
							Accept: 'application/vnd.github+json',
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({ access_token: accessToken }),
					}
				);
				if (!res.ok && res.status !== 422) {
					// 422 means token was already invalid — that's fine
					logError('sign-out', `GitHub token revocation returned ${res.status}`);
				}
			} catch (e) {
				// Network error calling GitHub — log but don't block sign-out
				logError('sign-out', 'Failed to revoke GitHub token:', e);
			}
		}

		// 3. Clear the token from the local account table
		try {
			await db
				.update(account)
				.set({ accessToken: null, refreshToken: null })
				.where(eq(account.userId, userId));
		} catch (e) {
			logError('sign-out', 'Failed to clear account tokens:', e);
		}

		// 4. Invalidate the better-auth session
		try {
			await auth.api.signOut({ headers: ctx.request.headers });
		} catch {
			// Session may already be expired — proceed
		}

		return { revoked: accessToken !== null };
	});
