import { Effect } from 'effect';
import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { API_PORT } from '@revv/shared';
import { auth } from './auth';
import { logError } from './logger';
import { AppRuntime } from './runtime';
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
import { debugRoutes } from './routes/debug';
import { PollScheduler } from './services/PollScheduler';
import { WalkthroughJobs } from './services/WalkthroughJobs';
import { RepoCloneService } from './services/RepoClone';

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
	.use(debugRoutes)
	.get('/api/health', () => ({
		status: 'ok' as const,
		timestamp: new Date().toISOString(),
	}))
	.listen(API_PORT);

console.log(`[revv-server] listening on http://localhost:${API_PORT}`);

// Re-launch walkthrough fibers for any rows left in `status='generating'`
// by a previous run. Runs in the background so boot isn't blocked by slow
// git clones or GitHub API calls; any per-row failures are logged and
// retries are capped via `resumeAttempts` so a poisoned row can't loop
// forever. Best-effort: we never want this to crash the server.
AppRuntime.runPromise(
	Effect.flatMap(WalkthroughJobs, (jobs) => jobs.resumePending()),
).catch((err) => {
	logError('walkthrough-resume', 'resumePending failed on boot:', err);
});

// Start the background sync scheduler on boot, decoupled from any UI
// client. Previously this was triggered from the WebSocket `open` handler,
// which meant sync only ran while the desktop window was open. With the
// Tauri app running in tray mode (window hidden / closed to tray), the
// server is the only long-lived process — it must drive its own polling.
//
// `start()` is idempotent (guards against duplicate fibers internally) and
// the sync loop gracefully no-ops when no GitHub token is available yet,
// so it's safe to call before the user has signed in.
AppRuntime.runPromise(
	Effect.flatMap(PollScheduler, (s) => s.start()),
).catch((err) => {
	logError('poll-scheduler', 'start failed on boot:', err);
});

// Resume any repos with cloneStatus 'pending' or 'error' on boot so that
// repos that failed to clone (e.g. due to a server restart mid-clone) are
// automatically retried without requiring user intervention.
AppRuntime.runPromise(
	Effect.flatMap(RepoCloneService, (svc) => svc.resumePendingClones()),
).catch((err) => {
	logError('repo-clone', 'resumePendingClones failed on boot:', err);
});

export type App = typeof app;
