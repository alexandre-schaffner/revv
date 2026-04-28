import { Effect } from 'effect';
import { AppRuntime } from '../../../runtime';
import { GitHubService } from '../../../services/GitHub';
import { PrContextService } from '../../../services/PrContext';
import { WalkthroughJobs } from '../../../services/WalkthroughJobs';
import { WalkthroughService } from '../../../services/Walkthrough';

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
 * generation for this PR and mark every existing walkthrough row
 * 'superseded' so the next SSE request creates a fresh row at the new
 * head SHA.
 *
 * Doctrine invariant #7 (CLAUDE.md): walkthroughs are immutable per head
 * SHA. We SUPERSEDE rather than DELETE so audit trail and AI comment
 * history survive across regenerations. `WalkthroughJobs.supersedeForPr`
 * is the chokepoint that already does both halves of the work — it
 * cancels any in-flight fiber first (Fiber.interrupt awaits the scope's
 * finalizers so the worktree is removed, the abort signal fires, and the
 * registry/sessionToken/semaphore entries are released before the DB
 * write), then transitions the rows to 'superseded' via UPDATE. This
 * matches the path taken by PollScheduler when it detects a head-SHA
 * change in the background, so the user-clicked Pull and the
 * polling-detected commit produce identical externally-observable state.
 */
export function regenerateWalkthroughHandler(prId: string) {
	return AppRuntime.runPromise(
		Effect.flatMap(WalkthroughJobs, (jobs) => jobs.supersedeForPr(prId)),
	);
}
