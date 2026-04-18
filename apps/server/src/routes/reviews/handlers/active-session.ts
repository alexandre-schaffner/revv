import { Effect } from 'effect';
import { AppRuntime } from '../../../runtime';
import { ReviewService } from '../../../services/Review';
import type { ThreadMessage } from '@revv/shared';

/**
 * GET /api/reviews/active/:prId — get or create the active session,
 * fully hydrated with its threads, their messages, and hunk decisions.
 *
 * Returns everything the review UI needs to render a PR from a cold start
 * in a single round-trip, avoiding the N+1 of separate fetches for the
 * session, its threads, and each thread's messages.
 */
export function activeSessionHandler(prId: string) {
	return AppRuntime.runPromise(
		Effect.gen(function* () {
			const reviewService = yield* ReviewService;

			const reviewSession = yield* reviewService.getOrCreateActiveSession(prId);
			const threads = yield* reviewService.getThreadsForSession(reviewSession.id);

			const messages: Record<string, ThreadMessage[]> = {};
			for (const thread of threads) {
				messages[thread.id] = yield* reviewService.getMessages(thread.id);
			}

			const hunkDecisions = yield* reviewService.getHunkDecisions(reviewSession.id);

			return { session: reviewSession, threads, messages, hunkDecisions };
		}),
	);
}
