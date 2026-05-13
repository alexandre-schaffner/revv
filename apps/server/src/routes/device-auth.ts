import { Elysia, t } from 'elysia';
import { eq } from 'drizzle-orm';
import { Effect } from 'effect';
import { db, GITHUB_CLIENT_ID, GITHUB_CLIENT_ID_PUBLIC } from '../auth';
import { user, session, account } from '../db/schema';
import { AppRuntime } from '../runtime';
import { SettingsService } from '../services/Settings';
import { serverEnv } from '../config';

// The device-code flow needs `client_id` only — no client_secret. If the
// bundled id is missing (someone replaced it with a placeholder), warn early
// so sign-in failures are easy to diagnose.
if (!GITHUB_CLIENT_ID || GITHUB_CLIENT_ID.startsWith('BUNDLED_') || GITHUB_CLIENT_ID.startsWith('REPLACE_')) {
	console.warn(
		'[device-auth] WARNING: GITHUB_CLIENT_ID looks like a placeholder — sign-in will fail for GHE. ' +
			'Override with the GITHUB_CLIENT_ID env var or fix the bundled value in apps/server/src/config.ts',
	);
}
// GITHUB_CLIENT_ID_PUBLIC being empty is fine if the user never picks github.com —
// we warn at request time instead of boot time (see resolveGithubUrls).

const DEVICE_FLOW_SCOPE = 'repo read:org user:email';

/**
 * Resolve the GitHub host at request time from user settings (set during
 * onboarding) with `config.githubHost` as the fallback for first-run
 * before the settings file has the field populated.
 *
 * `api.github.com` is the public github API hostname; GHE uses `api.<host>`.
 * Mirrors the derivation in {@link serverEnv}.
 */
async function resolveGithubUrls(): Promise<{
	host: string;
	clientId: string;
	deviceCodeUrl: string;
	tokenUrl: string;
	userUrl: string;
	emailsUrl: string;
}> {
	const settings = await AppRuntime.runPromise(
		Effect.flatMap(SettingsService, (s) => s.getSettings()).pipe(
			Effect.orElseSucceed(() => null),
		),
	);
	const host = settings?.githubHost?.trim() || serverEnv.githubHost;
	const isPublicGitHub = host === 'github.com';
	// Use the public client_id when targeting github.com; fail fast if it is
	// not configured so the user gets a clear error instead of a confusing
	// "invalid client" response from GitHub.
	let clientId: string;
	if (isPublicGitHub) {
		if (!GITHUB_CLIENT_ID_PUBLIC) {
			throw new Error(
				'Public GitHub sign-in requires GITHUB_CLIENT_ID_PUBLIC to be set. ' +
					'Register an OAuth App on github.com and add GITHUB_CLIENT_ID_PUBLIC=<id> to your .env file.',
			);
		}
		clientId = GITHUB_CLIENT_ID_PUBLIC;
	} else {
		clientId = GITHUB_CLIENT_ID;
	}
	const githubBase = `https://${host}`;
	const apiBase = isPublicGitHub ? 'https://api.github.com' : `https://api.${host}`;
	return {
		host,
		clientId,
		deviceCodeUrl: `${githubBase}/login/device/code`,
		tokenUrl: `${githubBase}/login/oauth/access_token`,
		userUrl: `${apiBase}/user`,
		emailsUrl: `${apiBase}/user/emails`,
	};
}

interface GitHubDeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

interface GitHubTokenResponse {
	access_token?: string;
	error?: string;
	interval?: number;
}

interface GitHubUser {
	id: number;
	login: string;
	name: string | null;
	email: string | null;
	avatar_url: string;
}

interface GitHubEmail {
	email: string;
	primary: boolean;
	verified: boolean;
}

function generateSecureToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function fetchGitHubUser(
	accessToken: string,
	urls: { userUrl: string },
): Promise<GitHubUser> {
	const res = await fetch(urls.userUrl, {
		headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
	});
	if (!res.ok) throw new Error(`GitHub user fetch failed: ${res.status}`);
	return res.json() as Promise<GitHubUser>;
}

async function fetchPrimaryEmail(
	accessToken: string,
	urls: { emailsUrl: string },
): Promise<string | null> {
	const res = await fetch(urls.emailsUrl, {
		headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
	});
	if (!res.ok) return null;
	const emails = (await res.json()) as GitHubEmail[];
	return emails.find((e) => e.primary)?.email ?? null;
}

async function upsertUserAndSession(
	accessToken: string,
	urls: { userUrl: string; emailsUrl: string },
): Promise<string> {
	const githubUser = await fetchGitHubUser(accessToken, urls);
	const primaryEmail = await fetchPrimaryEmail(accessToken, urls);
	const email = primaryEmail ?? githubUser.email;

	if (!email) throw new Error('No email address found on GitHub account');

	const now = new Date();
	const accountId = githubUser.id.toString();

	// Upsert user by email
	const existingUsers = await db.select().from(user).where(eq(user.email, email));
	const existingUser = existingUsers[0];

	let userId: string;
	if (existingUser) {
		userId = existingUser.id;
		await db
			.update(user)
			.set({
				name: githubUser.name ?? githubUser.login,
				image: githubUser.avatar_url,
				githubLogin: githubUser.login,
				updatedAt: now,
			})
			.where(eq(user.id, userId));
	} else {
		userId = crypto.randomUUID();
		await db.insert(user).values({
			id: userId,
			name: githubUser.name ?? githubUser.login,
			email,
			emailVerified: true,
			image: githubUser.avatar_url,
			githubLogin: githubUser.login,
			createdAt: now,
			updatedAt: now,
		});
	}

	// Upsert account by providerId + accountId
	const existingAccounts = await db
		.select()
		.from(account)
		.where(eq(account.accountId, accountId));
	const existingAccount = existingAccounts.find((a) => a.providerId === 'github');

	if (existingAccount) {
		await db
			.update(account)
			.set({ accessToken, updatedAt: now, userId })
			.where(eq(account.id, existingAccount.id));
	} else {
		await db.insert(account).values({
			id: crypto.randomUUID(),
			accountId,
			providerId: 'github',
			userId,
			accessToken,
			scope: DEVICE_FLOW_SCOPE,
			createdAt: now,
			updatedAt: now,
		});
	}

	// Create new session
	const sessionToken = generateSecureToken();
	const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

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
	.post('/api/auth/device/init', async ({ status }) => {
		const urls = await resolveGithubUrls();
		const res = await fetch(urls.deviceCodeUrl, {
			method: 'POST',
			headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify({ client_id: urls.clientId, scope: DEVICE_FLOW_SCOPE }),
		});

		if (!res.ok) {
			const body = await res.text().catch(() => '(unreadable)');
			console.error(`[device-auth] GitHub device code request failed: ${res.status} ${res.statusText}`, body);
			return status(502, { error: 'Failed to initiate device flow' });
		}

		const data = (await res.json()) as GitHubDeviceCodeResponse;
		return {
			device_code: data.device_code,
			user_code: data.user_code,
			verification_uri: data.verification_uri,
			expires_in: data.expires_in,
			interval: data.interval,
		};
	})
	.post(
		'/api/auth/device/poll',
		async ({ body, status }) => {
			const urls = await resolveGithubUrls();
			// Per GitHub's docs, device-flow token exchange does not take a
			// client_secret — only client_id, device_code, and grant_type.
			const res = await fetch(urls.tokenUrl, {
				method: 'POST',
				headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
				body: JSON.stringify({
					client_id: urls.clientId,
					device_code: body.device_code,
					grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				}),
			});

			const data = (await res.json()) as GitHubTokenResponse;

			if (data.access_token) {
				try {
					const token = await upsertUserAndSession(data.access_token, urls);
					return { status: 'success' as const, token };
				} catch (e) {
					console.error('[device-auth] session creation failed:', e);
					const message = e instanceof Error ? e.message : String(e);
					return status(500, { error: `Session creation failed: ${message}` });
				}
			}

			if (data.error === 'authorization_pending') return { status: 'pending' as const };
			if (data.error === 'slow_down')
				return { status: 'slow_down' as const, interval: data.interval ?? 10 };
			if (data.error === 'expired_token') return status(400, { error: 'expired' });
			if (data.error === 'access_denied') return status(400, { error: 'access_denied' });

			console.error('[device-auth] unexpected GitHub token response:', data);
			return status(400, { error: data.error ?? 'Unknown error from GitHub' });
		},
		{ body: t.Object({ device_code: t.String() }) }
	);
