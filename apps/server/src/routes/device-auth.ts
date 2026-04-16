import { Elysia, t } from 'elysia';
import { eq, and } from 'drizzle-orm';
import { GITHUB_CLIENT_ID, db } from '../auth';
import { user, account, session } from '../db/schema';
import { jsonResponse } from './middleware';

interface GitHubDeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

interface GitHubAccessTokenResponse {
	access_token?: string;
	token_type?: string;
	scope?: string;
	error?: string;
	error_description?: string;
}

interface GitHubUser {
	id: number;
	name: string | null;
	email: string | null;
	login: string;
}

interface GitHubEmail {
	email: string;
	primary: boolean;
	verified: boolean;
}

async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
	const res = await fetch('https://api.github.com/user', {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) throw new Error(`GitHub user fetch failed: ${res.status}`);
	return res.json() as Promise<GitHubUser>;
}

async function fetchPrimaryEmail(accessToken: string): Promise<string> {
	const res = await fetch('https://api.github.com/user/emails', {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) throw new Error(`GitHub emails fetch failed: ${res.status}`);
	const emails = (await res.json()) as GitHubEmail[];
	const primary = emails.find((e) => e.primary && e.verified);
	if (!primary) throw new Error('No primary verified email found on GitHub account');
	return primary.email;
}

async function upsertUserAndCreateSession(
	accessToken: string,
	scope: string,
	githubUser: GitHubUser,
	email: string
): Promise<string> {
	const now = new Date();
	const displayName = githubUser.name ?? githubUser.login;

	// Find or create user by email
	const existingUsers = await db.select().from(user).where(eq(user.email, email));
	const existingUser = existingUsers[0];
	const userId = existingUser?.id ?? crypto.randomUUID();

	if (!existingUser) {
		await db.insert(user).values({
			id: userId,
			name: displayName,
			email,
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		});
	} else {
		await db.update(user).set({ name: displayName, updatedAt: now }).where(eq(user.id, userId));
	}

	// Upsert GitHub account record
	const githubAccountId = String(githubUser.id);
	const existingAccounts = await db
		.select()
		.from(account)
		.where(and(eq(account.providerId, 'github'), eq(account.accountId, githubAccountId)));
	const existingAccount = existingAccounts[0];

	if (!existingAccount) {
		await db.insert(account).values({
			id: crypto.randomUUID(),
			providerId: 'github',
			accountId: githubAccountId,
			userId,
			accessToken,
			scope,
			createdAt: now,
			updatedAt: now,
		});
	} else {
		await db
			.update(account)
			.set({ accessToken, scope, updatedAt: now })
			.where(eq(account.id, existingAccount.id));
	}

	// Create new session
	const sessionToken = crypto.randomUUID();
	const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

	await db.insert(session).values({
		id: crypto.randomUUID(),
		token: sessionToken,
		userId,
		expiresAt,
		createdAt: now,
		updatedAt: now,
	});

	return sessionToken;
}

export const deviceAuthRoutes = new Elysia()
	.post('/api/auth/device/code', async () => {
		try {
			const res = await fetch('https://github.com/login/device/code', {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					client_id: GITHUB_CLIENT_ID,
					scope: 'repo read:org user:email',
				}),
			});

			if (!res.ok) {
				return jsonResponse({ error: `GitHub device code request failed: ${res.status}` }, 500);
			}

			const data = (await res.json()) as GitHubDeviceCodeResponse;
			return {
				device_code: data.device_code,
				user_code: data.user_code,
				verification_uri: data.verification_uri,
				expires_in: data.expires_in,
				interval: data.interval,
			};
		} catch (e) {
			return jsonResponse({ error: String(e) }, 500);
		}
	})
	.post(
		'/api/auth/device/poll',
		async ({ body }) => {
			const { device_code } = body;

			try {
				const res = await fetch('https://github.com/login/oauth/access_token', {
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						client_id: GITHUB_CLIENT_ID,
						device_code,
						grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
					}),
				});

				if (!res.ok) {
					return jsonResponse({ status: 'error', message: `GitHub poll failed: ${res.status}` }, 500);
				}

				const data = (await res.json()) as GitHubAccessTokenResponse;

				if (data.access_token) {
					const githubUser = await fetchGitHubUser(data.access_token);
					const email = await fetchPrimaryEmail(data.access_token);
					const token = await upsertUserAndCreateSession(
						data.access_token,
						data.scope ?? '',
						githubUser,
						email
					);
					return { status: 'success' as const, token };
				}

				switch (data.error) {
					case 'authorization_pending':
						return { status: 'pending' as const };
					case 'slow_down':
						return { status: 'slow_down' as const };
					case 'expired_token':
						return { status: 'expired' as const };
					case 'access_denied':
						return { status: 'denied' as const };
					default:
						return jsonResponse({
							status: 'error',
							message: data.error_description ?? data.error ?? 'Unknown GitHub error',
						}, 500);
				}
			} catch (e) {
				return jsonResponse({ status: 'error', message: String(e) }, 500);
			}
		},
		{
			body: t.Object({
				device_code: t.String(),
			}),
		}
	);
