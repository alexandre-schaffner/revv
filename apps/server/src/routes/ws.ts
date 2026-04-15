import { Elysia } from 'elysia';
import { Effect } from 'effect';
import { auth } from '../auth';
import { AppRuntime } from '../runtime';
import { PollScheduler } from '../services/PollScheduler';
import { WebSocketHub } from '../services/WebSocketHub';
import type { WsClientMessage } from '@rev/shared';

export const wsRoute = new Elysia().ws('/ws', {
	async open(ws) {
		// Authenticate via token query param or cookie
		const token = ws.data.query?.['token'] as string | undefined;
		if (!token) {
			ws.close(4001, 'Unauthorized');
			return;
		}

		// Validate the bearer token with Better Auth
		const headers = new Headers({ Authorization: `Bearer ${token}` });
		const session = await auth.api.getSession({ headers });
		if (!session) {
			ws.close(4001, 'Unauthorized');
			return;
		}

		await AppRuntime.runPromise(
			Effect.flatMap(WebSocketHub, (hub) => hub.register(ws.raw))
		);

		// Start poll scheduler if not running
		await AppRuntime.runPromise(
			Effect.flatMap(PollScheduler, (s) => s.start())
		).catch(() => {/* already running */});
	},

	async close(ws) {
		await AppRuntime.runPromise(
			Effect.flatMap(WebSocketHub, (hub) => hub.unregister(ws.raw))
		);
	},

	async message(ws, msg) {
		let parsed: WsClientMessage;
		try {
			parsed = JSON.parse(typeof msg === 'string' ? msg : JSON.stringify(msg)) as WsClientMessage;
		} catch {
			return;
		}

		if (parsed.type === 'prs:request-sync') {
			await AppRuntime.runPromise(
				Effect.flatMap(PollScheduler, (s) => s.syncNow())
			);
		}
	},
});
