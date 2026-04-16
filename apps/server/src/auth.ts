import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import { API_PORT } from '@rev/shared';
import { createDb } from './db/index';

// Config values — replaced at build time or via env vars
export const GITHUB_CLIENT_ID = process.env['GITHUB_CLIENT_ID'] ?? 'BUNDLED_CLIENT_ID';
export const GITHUB_CLIENT_SECRET = process.env['GITHUB_CLIENT_SECRET'] ?? 'BUNDLED_CLIENT_SECRET';
const BETTER_AUTH_SECRET = process.env['BETTER_AUTH_SECRET'] ?? 'dev-secret-change-in-production-32ch';

const db = createDb();

export { db };

export const auth = betterAuth({
	baseURL: `http://localhost:${API_PORT}`,
	secret: BETTER_AUTH_SECRET,
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
