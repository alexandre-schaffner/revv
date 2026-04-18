import { Effect } from 'effect';
import { AppRuntime } from '../../../runtime';
import { GitHubService } from '../../../services/GitHub';
import { PrContextService } from '../../../services/PrContext';
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
 * POST /api/reviews/:id/walkthrough/regenerate — invalidate all cached
 * walkthroughs for a PR. The next SSE request will generate fresh.
 */
export function regenerateWalkthroughHandler(prId: string, keptIssues: CarriedOverIssue[]) {
	return AppRuntime.runPromise(
		Effect.gen(function* () {
			const walkthroughService = yield* WalkthroughService;
			yield* walkthroughService.invalidateForPr(prId);
			if (keptIssues.length > 0) {
				yield* walkthroughService.setPendingCarriedOver(prId, keptIssues);
			}
		}),
	);
}
