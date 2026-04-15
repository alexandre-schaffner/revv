import { Elysia } from 'elysia';
import { auth } from '../auth';
import { storePendingToken } from './auth-pending';

export const authSuccessRoute = new Elysia().get('/auth/success', async (ctx) => {
	const session = await auth.api.getSession({ headers: ctx.request.headers });

	if (!session) {
		return new Response(
			`<!DOCTYPE html>
<html>
<head><title>Auth Failed</title></head>
<body><p>Authentication failed. Please try again.</p></body>
</html>`,
			{ status: 400, headers: { 'Content-Type': 'text/html' } }
		);
	}

	// The session token is used as the bearer token
	const token = session.session.token;

	// Store for desktop polling fallback (deep-link registration is unreliable in dev)
	storePendingToken(token);

	// Detect whether this is a Tauri desktop WebView or a regular browser.
	// Tauri's WebView always includes "Tauri" in the User-Agent.
	const userAgent = ctx.request.headers.get('user-agent') ?? '';
	const isTauri = userAgent.includes('Tauri');

	if (isTauri) {
		const deepLinkUrl = `rev://auth/callback?token=${encodeURIComponent(token)}`;
		return new Response(
			`<!DOCTYPE html>
<html>
<head>
  <title>Authenticated</title>
  <meta charset="utf-8" />
</head>
<body>
  <script>window.location.href = ${JSON.stringify(deepLinkUrl)};</script>
  <p>Authenticated! Redirecting to Rev...</p>
  <noscript><p>Authentication successful. You can close this window and return to Rev.</p></noscript>
</body>
</html>`,
			{ status: 200, headers: { 'Content-Type': 'text/html' } }
		);
	} else {
		// Browser dev mode (or Tauri external browser): the desktop / original tab
		// picks up the token via polling, so we just need to close this tab.
		return new Response(
			`<!DOCTYPE html>
<html>
<head>
  <title>Authenticated</title>
  <meta charset="utf-8" />
  <style>
    body { font-family: system-ui, sans-serif; display: flex; height: 100vh; align-items: center; justify-content: center; margin: 0; color: #666; }
    .container { text-align: center; }
    p { font-size: 14px; margin: 8px 0; }
    .muted { color: #999; font-size: 13px; }
  </style>
</head>
<body>
  <div class="container">
    <p>✓ Authenticated successfully</p>
    <p class="muted">You can close this tab and return to Rev.</p>
  </div>
  <script>
    // Try to close this tab/window automatically.
    // Works when the tab was opened by window.open() (browser dev mode).
    // Fails gracefully for tabs opened by OS (Tauri openUrl).
    try { window.close(); } catch (e) {}
  </script>
</body>
</html>`,
			{ status: 200, headers: { 'Content-Type': 'text/html' } }
		);
	}
});
