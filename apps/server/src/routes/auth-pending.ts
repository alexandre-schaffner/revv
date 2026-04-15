/**
 * Simple one-time token exchange so the desktop app doesn't depend on OS-level
 * deep-link registration (which is unreliable in Tauri dev mode).
 *
 * Flow:
 *  1. auth-success stores the session token here after OAuth completes.
 *  2. The desktop app polls GET /api/auth/pending-token every ~1.5 s.
 *  3. On the first successful poll the token is returned and cleared.
 */

interface PendingToken {
	token: string;
	expiresAt: number;
}

let pending: PendingToken | null = null;

export function storePendingToken(token: string): void {
	pending = { token, expiresAt: Date.now() + 5 * 60 * 1000 }; // 5-min TTL
}

import { Elysia } from 'elysia';

export const authPendingRoute = new Elysia().get('/api/auth/pending-token', () => {
	if (!pending || Date.now() > pending.expiresAt) {
		pending = null;
		return { token: null };
	}
	const { token } = pending;
	pending = null; // one-time use
	return { token };
});
