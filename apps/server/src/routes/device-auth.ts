import { Elysia, t } from 'elysia';
import { eq } from 'drizzle-orm';
import { db, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_HOST, GITHUB_API_BASE } from '../auth';
import { user, session, account } from '../db/schema';

if (GITHUB_CLIENT_ID === 'BUNDLED_CLIENT_ID') {
	console.warn('[device-auth] WARNING: GITHUB_CLIENT_ID is not set — sign-in will fail. Set it in .env');
}

const githubBase = `https://${GITHUB_HOST}`;

const GITHUB_DEVICE_CODE_URL = `${githubBase}/login/device/code`;
const GITHUB_TOKEN_URL = `${githubBase}/login/oauth/access_token`;
const GITHUB_API_USER_URL = `${GITHUB_API_BASE}/user`;
const GITHUB_API_EMAILS_URL = `${GITHUB_API_BASE}/user/emails`;
const DEVICE_FLOW_SCOPE = 'repo read:org user:email';

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

async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
	const res = await fetch(GITHUB_API_USER_URL, {
		headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
	});
	if (!res.ok) throw new Error(`GitHub user fetch failed: ${res.status}`);
	return res.json() as Promise<GitHubUser>;
}

async function fetchPrimaryEmail(accessToken: string): Promise<string | null> {
	const res = await fetch(GITHUB_API_EMAILS_URL, {
		headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
	});
	if (!res.ok) return null;
	const emails = (await res.json()) as GitHubEmail[];
	return emails.find((e) => e.primary)?.email ?? null;
}

async function upsertUserAndSession(
	accessToken: string
): Promise<string> {
	const githubUser = await fetchGitHubUser(accessToken);
	const primaryEmail = await fetchPrimaryEmail(accessToken);
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
		const res = await fetch(GITHUB_DEVICE_CODE_URL, {
			method: 'POST',
			headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: DEVICE_FLOW_SCOPE }),
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
			const res = await fetch(GITHUB_TOKEN_URL, {
				method: 'POST',
				headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
				body: JSON.stringify({
					client_id: GITHUB_CLIENT_ID,
					client_secret: GITHUB_CLIENT_SECRET,
					device_code: body.device_code,
					grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				}),
			});

			const data = (await res.json()) as GitHubTokenResponse;

			if (data.access_token) {
				try {
					const token = await upsertUserAndSession(data.access_token);
					return { status: 'success' as const, token };
				} catch (e) {
					return status(500, { error: `Session creation failed: ${e}` });
				}
			}

			if (data.error === 'authorization_pending') return { status: 'pending' as const };
			if (data.error === 'slow_down')
				return { status: 'slow_down' as const, interval: data.interval ?? 10 };
			if (data.error === 'expired_token') return status(400, { error: 'expired' });
			if (data.error === 'access_denied') return status(400, { error: 'access_denied' });

			return status(400, { error: data.error ?? 'Unknown error from GitHub' });
		},
		{ body: t.Object({ device_code: t.String() }) }
	);
