import { Effect } from 'effect';
import { AppRuntime } from '../../../runtime';
import { NotFoundError } from '../../../domain/errors';
import { GitHubService } from '../../../services/GitHub';
import { PrContextService } from '../../../services/PrContext';
import { WalkthroughJobs } from '../../../services/WalkthroughJobs';
import { WalkthroughService } from '../../../services/Walkthrough';

/**
 * GET /api/reviews/:id/walkthrough/cached — check whether a walkthrough
 * row exists for the PR's current HEAD commit, complete OR in-progress.
 *
 * Three response shapes:
 *   • `cached: true`,  `status: 'complete'`   → final cached row; client
 *     renders inline with no SSE round-trip.
 *   • `cached: true`,  `status: 'generating'` → resumed/in-flight job has
 *     partial content. Client hydrates what's available AND opens the SSE
 *     stream so subsequent writes (and the final `done`) flow through.
 *     This is the resume-on-restart path: without it, a `generating` row
 *     would look like `cached: false` to the client and fall through to
 *     the "Generate walkthrough" button while the server is already
 *     producing the walkthrough in the background.
 *   • `cached: false` → no walkthrough at this head SHA. Client shows
 *     the Generate button.
 *
 * The internal `opencodeSessionId` field on the partial result is
 * intentionally stripped before send — it's an orchestrator credential,
 * not something the UI consumes.
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
			if (cached) {
				return {
					cached: true as const,
					status: 'complete' as const,
					walkthrough: cached,
				};
			}

			const partial = yield* walkthroughService.getPartial(pr.id, meta.headSha);
			if (partial && partial.status === 'generating') {
				const { opencodeSessionId: _ignored, status: _status, ...walkthrough } = partial;
				return {
					cached: true as const,
					status: 'generating' as const,
					walkthrough,
				};
			}

			return { cached: false as const };
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

/**
 * POST /api/reviews/:id/walkthrough/resume — manually re-trigger generation
 * for an in-progress walkthrough that the user previously stopped.
 *
 * After `abort()` on the client, the DB row stays `status='generating'` with
 * `lastCompletedPhase` preserved (doctrine: orchestrator owns lifecycle, not
 * the user's stop button). Boot-time `WalkthroughJobs.resumePending()` already
 * handles such rows on server restart; this endpoint exposes the same path
 * to a user click so they can stop → think → resume without losing partial
 * progress.
 *
 * 404 when no row matches — the UI gates the Resume button on the same
 * "lastCompletedPhase < D + has-some-progress" signal, so a 404 here would
 * indicate either a head-SHA advance superseded the partial, or the row
 * was never created. Either way, Regenerate is the right next action.
 *
 * Resume-attempt cap (`WALKTHROUGH_MAX_RESUME_ATTEMPTS = 3`) is enforced
 * inside `startJob` for the resume trigger. Exceeded → 500 with the
 * underlying error surfaced.
 */
export function resumeWalkthroughHandler(
	prId: string,
): Promise<{ walkthroughId: string }> {
	return AppRuntime.runPromise(
		Effect.gen(function* () {
			const jobs = yield* WalkthroughJobs;
			const service = yield* WalkthroughService;
			const row = yield* service.findResumable(prId);
			if (!row) {
				return yield* Effect.fail(
					new NotFoundError({ resource: 'walkthrough', id: prId }),
				);
			}
			return yield* jobs.startJob({
				prId,
				userId: 'single-user',
				trigger: 'resume',
				walkthroughId: row.id,
			});
		}),
	);
}
