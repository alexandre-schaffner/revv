import { Context, Duration, Effect, Fiber, Layer, Ref, Schedule } from 'effect';
import { AUTO_FETCH_DEFAULT_INTERVAL } from '@rev/shared';
import type { PullRequest } from '@rev/shared';
import { DbService } from './Db';
import { withDb as withDbHelper } from '../effects/with-db';
import { DiffCacheService } from './DiffCache';
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
		const diffCache = yield* DiffCacheService;
		const repoService = yield* RepositoryService;
		const settingsService = yield* SettingsService;
		const tokenProvider = yield* TokenProvider;
		const { db } = yield* DbService;

		// Bind the captured db handle for convenience
		const withDb = <A, E>(eff: Effect.Effect<A, E, DbService>) => withDbHelper(db, eff);

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

			// Capture existing SHAs before sync for change detection
			const existingPrs = yield* withDb(prService.listPrs());
			const existingShaMap = new Map(
				existingPrs.map((pr) => [pr.id, { headSha: pr.headSha, baseSha: pr.baseSha }])
			);

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

			// Clear diff cache for PRs that were open before but are gone now (closed/merged)
			const freshPrIdSet = new Set(allPrs.map((pr) => pr.id));
			const closedPrIds = existingPrs
				.filter((pr) => pr.status === 'open' && !freshPrIdSet.has(pr.id))
				.map((pr) => pr.id);
			if (closedPrIds.length > 0) {
				yield* withDb(diffCache.invalidateFilesForPrs(closedPrIds)).pipe(
					Effect.orElseSucceed(() => undefined)
				);
			}

			// Detect PRs whose headSha or baseSha changed since last sync
			const changedPrIds = allPrs
				.filter((pr) => {
					const existing = existingShaMap.get(pr.id);
					if (!existing) return false; // new PR — no cached diffs yet
					return existing.headSha !== pr.headSha || existing.baseSha !== pr.baseSha;
				})
				.map((pr) => pr.id);

			// Refresh diffs only for PRs that had SHA changes AND already have cached diffs
			if (changedPrIds.length > 0) {
				const cachedPrIds = yield* withDb(diffCache.getPrIdsWithCachedDiffs());
				const cachedSet = new Set(cachedPrIds);
				const toRefresh = changedPrIds.filter((id) => cachedSet.has(id));

				if (toRefresh.length > 0) {
					// Invalidate stale cache entries first
					yield* withDb(diffCache.invalidateFilesForPrs(toRefresh)).pipe(
						Effect.orElseSucceed(() => undefined)
					);

					// Re-fetch diffs sequentially to avoid rate limit bursts
					yield* Effect.forEach(
						toRefresh,
						(prId) =>
							Effect.gen(function* () {
								const pr = allPrs.find((p) => p.id === prId);
								if (!pr) return;

								const repo = allRepos.find((r) => r.id === pr.repositoryId);
								if (!repo) return;

								const token = yield* tokenProvider
									.getGitHubToken('single-user')
									.pipe(Effect.orElseSucceed(() => ''));
								if (!token) return;

								const fileList = yield* github
									.getPrFiles(repo.fullName, pr.externalId, token)
									.pipe(Effect.orElseSucceed(() => []));

								const files = fileList.map((f) => ({
									path: f.filename,
									oldPath: f.previousFilename,
									status: f.status,
									additions: f.additions,
									deletions: f.deletions,
									patch: f.patch,
									fetchedAt: new Date().toISOString(),
								}));

								yield* withDb(diffCache.cacheFiles(prId, files)).pipe(
									Effect.orElseSucceed(() => undefined)
								);
							}).pipe(Effect.orElseSucceed(() => undefined)),
						{ concurrency: 1 }
					);
				}
			}

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
