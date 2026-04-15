import { Context, Duration, Effect, Fiber, Layer, Ref, Schedule } from 'effect';
import { AUTO_FETCH_DEFAULT_INTERVAL } from '@rev/shared';
import type { PullRequest } from '@rev/shared';
import { DbService } from './Db';
import { GitHubService } from './GitHub';
import { PullRequestService } from './PullRequest';
import { RepositoryService } from './Repository';
import { SettingsService } from './Settings';
import { TokenProvider } from './TokenProvider';
import { WebSocketHub } from './WebSocketHub';

type PollSchedulerService = {
	readonly start: () => Effect.Effect<void>;
	readonly stop: () => Effect.Effect<void>;
	readonly restart: (intervalMinutes: number) => Effect.Effect<void>;
	readonly syncNow: () => Effect.Effect<void>;
};

export class PollScheduler extends Context.Tag('PollScheduler')<
	PollScheduler,
	PollSchedulerService
>() {}

export const PollSchedulerLive = Layer.effect(
	PollScheduler,
	Effect.gen(function* () {
		// Capture all dependencies once at layer construction time
		const hub = yield* WebSocketHub;
		const github = yield* GitHubService;
		const prService = yield* PullRequestService;
		const repoService = yield* RepositoryService;
		const settingsService = yield* SettingsService;
		const tokenProvider = yield* TokenProvider;
		const { db } = yield* DbService;

		// Provide DbService from the captured db handle for effects that require it
		const withDb = <A, E>(eff: Effect.Effect<A, E, DbService>): Effect.Effect<A, E> =>
			Effect.provideService(eff, DbService, { db });

		// Fiber ref for the running poll loop — null when stopped
		const fiberRef = yield* Ref.make<Fiber.RuntimeFiber<number, never> | null>(null);

		// The core sync effect — all services are plain values captured from the closure
		const syncAllRepos: Effect.Effect<void> = Effect.gen(function* () {
			yield* hub.broadcast({ type: 'prs:sync-started' });

			const allRepos = yield* withDb(repoService.listRepos());

			if (allRepos.length === 0) {
				yield* hub.broadcast({
					type: 'prs:sync-complete',
					data: { count: 0, timestamp: new Date().toISOString() },
				});
				return;
			}

			const results = yield* Effect.forEach(
				allRepos,
				(repo) =>
					Effect.gen(function* () {
						const token = yield* tokenProvider
							.getGitHubToken('single-user')
							.pipe(Effect.orElseSucceed(() => ''));

						if (!token) return [] as PullRequest[];

						const prs = yield* github
							.listPrs(repo.fullName, repo.id, token)
							.pipe(Effect.orElseSucceed(() => [] as PullRequest[]));

						yield* withDb(prService.upsertPrs(prs)).pipe(
							Effect.orElseSucceed(() => undefined)
						);

						return prs;
					}).pipe(Effect.orElseSucceed(() => [] as PullRequest[])),
				{ concurrency: 3 }
			);

			const allPrs = results.flat();
			yield* hub.broadcast({ type: 'prs:updated', data: allPrs });
			yield* hub.broadcast({
				type: 'prs:sync-complete',
				data: { count: allPrs.length, timestamp: new Date().toISOString() },
			});
		}).pipe(
			Effect.catchAllCause((cause) =>
				hub.broadcast({
					type: 'error',
					data: { code: 'SYNC_ERROR', message: String(cause) },
				})
			)
		);

		const stopFiber: Effect.Effect<void> = Effect.gen(function* () {
			const fiber = yield* Ref.get(fiberRef);
			if (fiber !== null) {
				yield* Fiber.interrupt(fiber).pipe(Effect.asVoid);
				yield* Ref.set(fiberRef, null);
			}
		});

		const startWithInterval = (intervalMinutes: number): Effect.Effect<void> =>
			Effect.gen(function* () {
				if (intervalMinutes <= 0) return;
				// Run immediately on start, then repeat at the given interval
				const schedule = Schedule.spaced(Duration.minutes(intervalMinutes));
				const fiber: Fiber.RuntimeFiber<number, never> = yield* Effect.fork(
					syncAllRepos.pipe(Effect.repeat(schedule))
				);
				yield* Ref.set(fiberRef, fiber);
			});

		return {
			start: () =>
				Effect.gen(function* () {
					const s = yield* withDb(settingsService.getSettings()).pipe(
						Effect.orElseSucceed(() => ({ autoFetchInterval: AUTO_FETCH_DEFAULT_INTERVAL }))
					);
					yield* startWithInterval(s.autoFetchInterval);
				}),

			stop: () => stopFiber,

			restart: (minutes) =>
				Effect.gen(function* () {
					yield* stopFiber;
					yield* startWithInterval(minutes);
				}),

			syncNow: () => syncAllRepos,
		};
	})
);
