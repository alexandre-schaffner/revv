import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { API_PORT } from '@revv/shared';
import { auth } from './auth';
import { explainRoute } from './routes/explain';
import { repoRoutes } from './routes/repos';
import { githubRoutes } from './routes/github';
import { prRoutes } from './routes/prs';
import { reviewRoutes } from './routes/reviews';
import { threadRoutes } from './routes/threads';
import { settingsRoutes } from './routes/settings';
import { signOutRoute } from './routes/sign-out';
import { deviceAuthRoutes } from './routes/device-auth';
import { userRoutes } from './routes/user';
import { wsRoute } from './routes/ws';

const app = new Elysia()
	.use(
		cors({
			origin: /localhost/,
			credentials: true,
			allowedHeaders: ['Content-Type', 'Authorization'],
			methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
		})
	)
	.mount(auth.handler)
	.use(explainRoute)
	.use(repoRoutes)
	.use(githubRoutes)
	.use(prRoutes)
	.use(reviewRoutes)
	.use(threadRoutes)
	.use(settingsRoutes)
	.use(signOutRoute)
	.use(deviceAuthRoutes)
	.use(userRoutes)
	.use(wsRoute)
	.get('/api/health', () => ({
		status: 'ok' as const,
		timestamp: new Date().toISOString(),
	}))
	.listen(API_PORT);

console.log(`[revv-server] listening on http://localhost:${API_PORT}`);

export type App = typeof app;
