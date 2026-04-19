import { Effect } from 'effect';
import { AppRuntime } from '../../../runtime';
import { GitHubService } from '../../../services/GitHub';
import { PrContextService } from '../../../services/PrContext';
import { WalkthroughJobs } from '../../../services/WalkthroughJobs';
import { WalkthroughService } from '../../../services/Walkthrough';
import type { CarriedOverIssue } from '@revv/shared';

/**
 * GET /api/reviews/:id/walkthrough/cached — check whether a cached
 * walkthrough exists for the PR's current HEAD commit.
 *
 * The client uses this to decide between rendering cached content
 * instantly vs. opening the SSE stream to generate a fresh walkthrough.
 */
export function getCachedWalkthroughHandler(prId: string, userId: string) {
	return AppRuntime.runPromise(
		Effect.gen(function* () {
			const prContext = yield* PrContextService;
			const github = yield* GitHubService;
			const walkthroughService = yield* WalkthroughService;

			const { pr, repo, token } = yield* prContext.resolveBasic(prId, userId);
			const meta = yield* github.getPrMeta(repo.fullName, pr.externalId, token);

			const cached = yield* walkthroughService.getCached(pr.id, meta.headSha);
			return cached
				? { cached: true as const, walkthrough: cached }
				: { cached: false as const };
		}),
	);
}

/**
 * POST /api/reviews/:id/walkthrough/regenerate — cancel any in-flight
 * generation for this PR and invalidate cached walkthroughs so the next
 * SSE request starts fresh.
 *
 * Order matters: we cancel BEFORE invalidate. Cancel awaits fiber
 * termination so the scope finalizers (worktree cleanup, abort signal)
 * have run by the time we touch the DB. If we invalidated first, the
 * still-running fiber could race its `markComplete` / `addBlock` writes
 * against our delete, producing orphan rows or partial-new rows.
 */
export function regenerateWalkthroughHandler(prId: string, keptIssues: CarriedOverIssue[]) {
	return AppRuntime.runPromise(
		Effect.gen(function* () {
			const jobs = yield* WalkthroughJobs;
			const walkthroughService = yield* WalkthroughService;

			// Cancel the active job (if any). `cancel` awaits Fiber.interrupt,
			// which flushes the job's scope — worktree is removed, controller
			// is aborted, and the row has been marked `error` so the next
			// invalidate clears clean state.
			const active = yield* jobs.findActiveByPr(prId);
			if (active !== null) {
				yield* jobs.cancel(active.walkthroughId);
			}

			yield* walkthroughService.invalidateForPr(prId);
			if (keptIssues.length > 0) {
				yield* walkthroughService.setPendingCarriedOver(prId, keptIssues);
			}
		}),
	);
}
