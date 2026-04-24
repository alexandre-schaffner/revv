import { Cause, Context, Duration, Effect, Fiber, Layer, Ref, Schedule } from 'effect';
import { eq } from 'drizzle-orm';
import { AUTO_FETCH_DEFAULT_INTERVAL, THREAD_SYNC_INTERVAL_SECONDS } from '@revv/shared';
import type { PullRequest, SyncChange } from '@revv/shared';
import { DbService } from './Db';
import { withDb as withDbHelper } from '../effects/with-db';
import { DiffCacheService } from './DiffCache';
import { GitHubService } from './GitHub';
import { GitHubEtagCache } from './GitHubEtagCache';
import { PullRequestService } from './PullRequest';
import { RepositoryService } from './Repository';
import { SettingsService } from './Settings';
import { SyncService } from './Sync';
import { TokenProvider } from './TokenProvider';
import { WalkthroughJobs } from './WalkthroughJobs';
import { WebSocketHub } from './WebSocketHub';
import { user } from '../db/schema/auth';

type PollSchedulerService = {
	readonly start: () => Effect.Effect<void>;
	readonly stop: () => Effect.Effect<void>;
	readonly restart: (intervalMinutes: number) => Effect.Effect<void>;
	readonly syncNow: () => Effect.Effect<void>;
	readonly syncThreadsNow: (prId: string) => Effect.Effect<void>;
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
		const syncService = yield* SyncService;
		const tokenProvider = yield* TokenProvider;
		const etagCache = yield* GitHubEtagCache;
		const walkthroughJobs = yield* WalkthroughJobs;
		const { db } = yield* DbService;

		// Bind the captured db handle for convenience
		const withDb = <A, E>(eff: Effect.Effect<A, E, DbService>) => withDbHelper(db, eff);

		// Provide `DbService` + `GitHubEtagCache` (both captured at layer
		// construction) so effects that transitively call `github.*` REST methods
		// — which now participate in the ETag cache — don't leak those services
		// into the public Tag signatures.
		const provideInfra = <A, E>(
			eff: Effect.Effect<A, E, DbService | GitHubEtagCache>,
		): Effect.Effect<A, E> =>
			eff.pipe(
				Effect.provideService(DbService, { db }),
				Effect.provideService(GitHubEtagCache, etagCache),
			);

		// Tracks whether at least one periodic sync has completed.
		// The first periodic sync is used as baseline — we don't know what
		// changed vs the prior server run, so we skip notifications for it.
		const hasPeriodicSyncedOnceRef = yield* Ref.make(false);
		// Set to true by syncNow to suppress the summary during manual syncs.
		const suppressSummaryRef = yield* Ref.make(false);

		// Fiber ref for the running poll loop — null when stopped
		const fiberRef = yield* Ref.make<Fiber.RuntimeFiber<number, never> | null>(null);

		// The core sync effect — all services are plain values captured from the closure.
		// `DbService | GitHubEtagCache` remain in R because `github.*` methods depend
		// on them internally (for ETag cache reads/writes); the layer that constructs
		// PollScheduler already has both provided, so the forked fiber inherits them.
		const syncAllRepos: Effect.Effect<void, never, DbService | GitHubEtagCache> = Effect.gen(function* () {
			yield* hub.broadcast({ type: 'prs:sync-started' });

			// Snapshot ETag-cache counters so we can report deltas for this cycle.
			const etagStatsBefore = etagCache.stats();

			const allRepos = yield* withDb(repoService.listRepos());

			if (allRepos.length === 0) {
				const etagStatsAfter = etagCache.stats();
				yield* hub.broadcast({
					type: 'prs:sync-complete',
					data: {
						count: 0,
						timestamp: new Date().toISOString(),
						cached: etagStatsAfter.hits304 - etagStatsBefore.hits304,
						refetched: etagStatsAfter.misses200 - etagStatsBefore.misses200,
					},
				});
				return;
			}

			// Capture existing SHAs before sync for change detection
			const existingPrs = yield* withDb(prService.listPrs());
			const existingShaMap = new Map(
				existingPrs.map((pr) => [pr.id, { headSha: pr.headSha, baseSha: pr.baseSha }])
			);

			// ── Refresh repo metadata (avatar URL, default branch) ────────────────
			// Bypasses the ETag cache — some GitHub Enterprise instances return
			// signed `avatar_url`s whose token expires without invalidating the
			// endpoint's ETag, so a plain `getRepo` would replay the stale body.
			// Runs before PR sync so the sidebar sees fresh avatars ASAP after
			// server startup.
			let anyRepoChanged = false;
			yield* Effect.forEach(
				allRepos,
				(repo) =>
					Effect.gen(function* () {
						const token = yield* tokenProvider.getGitHubToken('single-user').pipe(
							Effect.catchAll(() => Effect.succeed('')),
						);
						if (!token) return;
						const fresh = yield* github.getRepoFresh(repo.fullName, token).pipe(
							Effect.catchAll(() => Effect.succeed(null)),
						);
						if (!fresh) return;
						if (
							fresh.avatarUrl !== repo.avatarUrl ||
							fresh.defaultBranch !== repo.defaultBranch
						) {
							yield* withDb(
								repoService.updateRepoMetadata(repo.id, {
									avatarUrl: fresh.avatarUrl,
									defaultBranch: fresh.defaultBranch,
								}),
							).pipe(Effect.orElseSucceed(() => undefined));
							anyRepoChanged = true;
						}
					}).pipe(Effect.orElseSucceed(() => undefined)),
				{ concurrency: 3 },
			);

			if (anyRepoChanged) {
				const refreshedRepos = yield* withDb(repoService.listRepos());
				yield* hub.broadcast({ type: 'repos:updated', data: refreshedRepos });
			}

			// ── Refresh authenticated user avatar ────────────────────────────────
			// Same rationale as the repo-metadata refresh above: GitHub Enterprise
			// signed `avatar_url`s on the /user endpoint expire without the ETag
			// changing, so a cached response replays a dead token. Bypassing the
			// ETag cache keeps the stored `user.image` fresh so sidebars, comment
			// headers, and the settings page don't render broken avatars after the
			// signed URL rotates.
			yield* Effect.gen(function* () {
				const token = yield* tokenProvider.getGitHubToken('single-user').pipe(
					Effect.catchAll(() => Effect.succeed('')),
				);
				if (!token) return;
				const fresh = yield* github.getAuthenticatedUserFresh(token).pipe(
					Effect.catchAll(() => Effect.succeed(null)),
				);
				if (!fresh) return;
				const userRow = db.select().from(user).limit(1).get();
				if (!userRow) return;
				if (userRow.image === fresh.avatarUrl) return;
				yield* Effect.try({
					try: () =>
						db
							.update(user)
							.set({ image: fresh.avatarUrl, updatedAt: new Date() })
							.where(eq(user.id, userRow.id))
							.run(),
					catch: (e) => new Error(String(e)),
				}).pipe(Effect.orElseSucceed(() => undefined));
				yield* hub.broadcast({
					type: 'user:updated',
					data: {
						id: userRow.id,
						name: userRow.name,
						email: userRow.email,
						image: fresh.avatarUrl,
						githubLogin: userRow.githubLogin ?? null,
					},
				});
			}).pipe(Effect.orElseSucceed(() => undefined));

			const results = yield* Effect.forEach(
				allRepos,
				(repo) =>
					Effect.gen(function* () {
						// Auth failures must not silently poison the token: log + skip this
						// repo's PR sync this cycle. All other errors are logged generically.
						const token = yield* tokenProvider.getGitHubToken('single-user').pipe(
							Effect.catchTag('GitHubAuthError', (err) =>
								Effect.sync(() => {
									console.warn(
										`[PollScheduler] GitHub auth unavailable; skipping PR sync for ${repo.fullName}: ${err.message}`,
									);
									return '';
								}),
							),
						);

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

			// Delete PRs that were open before but are gone now (closed/merged on GitHub).
			// Cascade deletes their diff cache, review sessions, threads, and walkthroughs.
			const freshPrIdSet = new Set(allPrs.map((pr) => pr.id));
			const closedPrIds = existingPrs
				.filter((pr) => pr.status === 'open' && !freshPrIdSet.has(pr.id))
				.map((pr) => pr.id);
			if (closedPrIds.length > 0) {
				yield* withDb(prService.deletePrs(closedPrIds)).pipe(
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

			// Head-SHA change → walkthroughs for this PR pin to the OLD SHA and
			// are now stale. Per doctrine invariant #7 (walkthroughs are immutable
			// per head SHA), we mark them 'superseded' rather than mutate or
			// delete. A fresh walkthrough row is created on the next user-opens-PR
			// flow for the new SHA.
			const headShaChangedPrIds = allPrs
				.filter((pr) => {
					const existing = existingShaMap.get(pr.id);
					return existing !== undefined && existing.headSha !== pr.headSha;
				})
				.map((pr) => pr.id);
			for (const prId of headShaChangedPrIds) {
				yield* walkthroughJobs
					.supersedeForPr(prId)
					.pipe(Effect.catchAll(() => Effect.void));
			}

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

								const token = yield* tokenProvider.getGitHubToken('single-user').pipe(
									Effect.catchTag('GitHubAuthError', (err) =>
										Effect.sync(() => {
											console.warn(
												`[PollScheduler] GitHub auth unavailable; skipping diff refresh for PR ${prId}: ${err.message}`,
											);
											return '';
										}),
									),
								);
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

			// ── Sync diff: compute what changed for notifications ────────────────
			const changes: SyncChange[] = [];

			if (existingPrs.length > 0) {
				const userRow = db.select({ githubLogin: user.githubLogin }).from(user).get();
				const userLogin = userRow?.githubLogin ?? null;

				const existingMap = new Map(existingPrs.map((pr) => [pr.id, pr]));

				for (const pr of allPrs) {
					const repoFullName = allRepos.find((r) => r.id === pr.repositoryId)?.fullName ?? pr.repositoryId;
					const existing = existingMap.get(pr.id);

					if (!existing) {
						if (userLogin && pr.requestedReviewers.includes(userLogin)) {
							changes.push({ kind: 'review_requested', prId: pr.id, prTitle: pr.title, prNumber: pr.externalId, repoFullName });
						} else if (userLogin && pr.authorLogin === userLogin) {
							changes.push({ kind: 'pr_authored', prId: pr.id, prTitle: pr.title, prNumber: pr.externalId, repoFullName });
						}
					} else {
						if (existing.headSha !== pr.headSha) {
							changes.push({ kind: 'pr_updated', prId: pr.id, prTitle: pr.title, prNumber: pr.externalId, repoFullName });
						} else if (
							userLogin &&
							pr.requestedReviewers.includes(userLogin) &&
							!existing.requestedReviewers.includes(userLogin)
						) {
							changes.push({ kind: 'review_requested', prId: pr.id, prTitle: pr.title, prNumber: pr.externalId, repoFullName });
						}
					}
				}

				for (const prId of closedPrIds) {
					const pr = existingMap.get(prId);
					if (pr) {
						const repoFullName = allRepos.find((r) => r.id === pr.repositoryId)?.fullName ?? pr.repositoryId;
						changes.push({ kind: 'pr_closed', prId: prId, prTitle: pr.title, prNumber: pr.externalId, repoFullName });
					}
				}
			}

			const suppressSummary = yield* Ref.get(suppressSummaryRef);
			const hasPeriodicSyncedOnce = yield* Ref.get(hasPeriodicSyncedOnceRef);
			if (!suppressSummary && hasPeriodicSyncedOnce && changes.length > 0) {
				yield* hub.broadcast({ type: 'prs:sync-summary', data: changes });
			}
			yield* Ref.set(hasPeriodicSyncedOnceRef, true);
			yield* Ref.set(suppressSummaryRef, false);

			const etagStatsAfter = etagCache.stats();
			yield* hub.broadcast({
				type: 'prs:sync-complete',
				data: {
					count: allPrs.length,
					timestamp: new Date().toISOString(),
					cached: etagStatsAfter.hits304 - etagStatsBefore.hits304,
					refetched: etagStatsAfter.misses200 - etagStatsBefore.misses200,
				},
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

		// ── Thread sync loop ──────────────────────────────────────────────────
		// Separate, lightweight fiber that polls every ~30s to keep threads in
		// sync with GitHub. Runs in addition to the PR-sync fiber above.
		const threadFiberRef = yield* Ref.make<Fiber.RuntimeFiber<number, never> | null>(null);

		const syncThreadsForOpenPrs: Effect.Effect<void> = Effect.gen(function* () {
			const prs = yield* withDb(prService.listPrs()).pipe(
				Effect.orElseSucceed(() => [] as PullRequest[]),
			);
			const openPrs = prs.filter((p) => p.status === 'open');
			// Sequential is fine: each PR-sync is lightweight (REST + a small
			// GraphQL call). Running them concurrently would spike rate-limit risk.
			yield* Effect.forEach(
				openPrs,
				(pr) =>
					withDb(syncService.syncThreads(pr.id)).pipe(
						Effect.asVoid,
						Effect.catchAllCause((cause) =>
							Effect.sync(() => {
								console.error(`[PollScheduler] Thread sync failed for PR ${pr.id}:`, Cause.pretty(cause));
							})
						),
					),
				{ concurrency: 1 },
			);
		}).pipe(
			Effect.catchAllCause((cause) =>
				hub.broadcast({
					type: 'error',
					data: { code: 'THREAD_SYNC_ERROR', message: String(cause) },
				}),
			),
		);

		const stopThreadFiber: Effect.Effect<void> = Effect.gen(function* () {
			const fiber = yield* Ref.get(threadFiberRef);
			if (fiber !== null) {
				yield* Fiber.interrupt(fiber).pipe(Effect.asVoid);
				yield* Ref.set(threadFiberRef, null);
			}
		});

		const startThreadFiber: Effect.Effect<void> = Effect.gen(function* () {
			const schedule = Schedule.spaced(Duration.seconds(THREAD_SYNC_INTERVAL_SECONDS));
			const fiber: Fiber.RuntimeFiber<number, never> = yield* Effect.fork(
				syncThreadsForOpenPrs.pipe(Effect.repeat(schedule)),
			);
			yield* Ref.set(threadFiberRef, fiber);
		});

		const startWithInterval = (intervalMinutes: number): Effect.Effect<void> =>
			Effect.gen(function* () {
				if (intervalMinutes <= 0) return;
				// Run immediately on start, then repeat at the given interval
				const schedule = Schedule.spaced(Duration.minutes(intervalMinutes));
				const fiber: Fiber.RuntimeFiber<number, never> = yield* Effect.fork(
					provideInfra(syncAllRepos.pipe(Effect.repeat(schedule))),
				);
				yield* Ref.set(fiberRef, fiber);
			});

		return {
			start: () =>
				Effect.gen(function* () {
					// Guard: don't start duplicate fibers if already running
					const existingFiber = yield* Ref.get(threadFiberRef);
					if (existingFiber !== null) return;

					const s = yield* withDb(settingsService.getSettings()).pipe(
						Effect.orElseSucceed(() => ({ autoFetchInterval: AUTO_FETCH_DEFAULT_INTERVAL }))
					);
					yield* startWithInterval(s.autoFetchInterval);
					yield* startThreadFiber;
				}),

			stop: () =>
				Effect.gen(function* () {
					yield* stopFiber;
					yield* stopThreadFiber;
				}),

			restart: (minutes) =>
				Effect.gen(function* () {
					yield* stopFiber;
					yield* startWithInterval(minutes);
				}),

			syncNow: () =>
				provideInfra(
					Effect.gen(function* () {
						yield* Ref.set(suppressSummaryRef, true);
						yield* syncAllRepos;
					}),
				),

			syncThreadsNow: (prId: string) =>
				withDb(syncService.syncThreads(prId)).pipe(
					Effect.asVoid,
					Effect.catchAllCause((cause) => {
						const message = Cause.pretty(cause);
						console.error(`[PollScheduler] Manual thread sync failed for PR ${prId}:`, message);
						return hub.broadcast({
							type: 'threads:sync-error',
							data: { prId, message },
						});
					}),
				),
		};
	})
);
