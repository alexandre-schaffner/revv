import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import { API_PORT } from '@revv/shared';
import { createDb } from './db/index';
import { serverEnv } from './config';

// Re-exported for the handful of routes that still reach in directly.
// All values are sourced from the centralized `serverEnv` snapshot in
// `config.ts`, which resolves Effect's `ServerConfig` once at startup.
export const GITHUB_CLIENT_ID = serverEnv.githubClientId;
export const GITHUB_CLIENT_SECRET = serverEnv.githubClientSecret;
export const GITHUB_HOST = serverEnv.githubHost;
export const GITHUB_API_BASE = serverEnv.githubApiBase;

const db = createDb();

export { db };

export const auth = betterAuth({
	baseURL: `http://localhost:${API_PORT}`,
	secret: serverEnv.betterAuthSecret,
	database: drizzleAdapter(db, {
		provider: 'sqlite',
	}),
	socialProviders: {
		github: {
			clientId: GITHUB_CLIENT_ID,
			clientSecret: GITHUB_CLIENT_SECRET,
			scope: ['repo', 'read:org', 'user:email'],
		},
	},
	plugins: [bearer()],
	trustedOrigins: ['http://localhost:5173', 'tauri://localhost', 'https://tauri.localhost'],
	account: {
		// Store OAuth state entirely in an encrypted cookie instead of DB + signed-cookie.
		// This avoids cross-origin cookie mismatch errors when the sign-in fetch originates
		// from localhost:5173 but the callback lands on localhost:45678.
		storeStateStrategy: 'cookie',
	},
});
