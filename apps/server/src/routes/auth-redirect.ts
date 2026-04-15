import { Elysia } from 'elysia';
import { API_PORT } from '@rev/shared';
import { auth } from '../auth';

/**
 * GET /api/auth/sign-in/github
 *
 * Initiates the GitHub OAuth flow via a direct browser navigation instead of a
 * cross-origin fetch. This ensures the state cookie is set in a first-party
 * context (localhost:45678 → localhost:45678), so the browser reliably sends it
 * back when GitHub redirects to the callback.
 *
 * Usage:
 *   window.location.href = `${API_BASE_URL}/api/auth/sign-in/github`
 *   openUrl(`${API_BASE_URL}/api/auth/sign-in/github`)   // Tauri
 */
export const authRedirectRoute = new Elysia().get(
	'/api/auth/sign-in/github',
	async (ctx) => {
		const callbackURL = (ctx.query as Record<string, string>).callbackURL ?? '/auth/success';

		// Call Better Auth sign-in internally — same process, no cross-origin
		const internalReq = new Request(
			`http://localhost:${API_PORT}/api/auth/sign-in/social`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					host: `localhost:${API_PORT}`,
				},
				body: JSON.stringify({ provider: 'github', callbackURL }),
			}
		);

		const baResponse = await auth.handler(internalReq);
		const data = (await baResponse.json()) as { url?: string };

		if (!data.url) {
			return new Response('Failed to initiate OAuth flow', { status: 500 });
		}

		// Forward the state cookie Better Auth set, then redirect the browser to GitHub
		const setCookie = baResponse.headers.get('set-cookie');
		if (setCookie) {
			ctx.set.headers['set-cookie'] = setCookie;
		}

		return ctx.redirect(data.url, 302);
	}
);
