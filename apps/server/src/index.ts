import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { API_PORT } from '@rev/shared';
import { auth } from './auth';
import { authRedirectRoute } from './routes/auth-redirect';
import { authSuccessRoute } from './routes/auth-success';
import { authPendingRoute } from './routes/auth-pending';
import { explainRoute } from './routes/explain';
import { repoRoutes } from './routes/repos';
import { githubRoutes } from './routes/github';
import { prRoutes } from './routes/prs';
import { reviewRoutes } from './routes/reviews';
import { threadRoutes } from './routes/threads';
import { settingsRoutes } from './routes/settings';
import { wsRoute } from './routes/ws';

const app = new Elysia()
	.use(
		cors({
			origin: /localhost/,
			credentials: true,
			allowedHeaders: ['Content-Type', 'Authorization'],
			methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
		})
	)
	.mount(auth.handler)
	.use(authRedirectRoute)
	.use(authSuccessRoute)
	.use(authPendingRoute)
	.use(explainRoute)
	.use(repoRoutes)
	.use(githubRoutes)
	.use(prRoutes)
	.use(reviewRoutes)
	.use(threadRoutes)
	.use(settingsRoutes)
	.use(wsRoute)
	.get('/api/health', () => ({
		status: 'ok' as const,
		timestamp: new Date().toISOString(),
	}))
	.listen(API_PORT);

console.log(`[rev-server] listening on http://localhost:${API_PORT}`);

export type App = typeof app;
