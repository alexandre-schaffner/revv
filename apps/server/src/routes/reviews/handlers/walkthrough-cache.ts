import { Effect } from "effect";
import { NotFoundError } from "../../../domain/errors";
import { AppRuntime } from "../../../runtime";
import { GitHubGateway } from "../../../services/GitHub";
import { PrContextService } from "../../../services/PrContext";
import { WalkthroughService } from "../../../services/Walkthrough";
import { WalkthroughJobs } from "../../../services/WalkthroughJobs";

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
      const github = yield* GitHubGateway;
      const walkthroughService = yield* WalkthroughService;
      const jobs = yield* WalkthroughJobs;

      const { pr, repo, token } = yield* prContext.resolveBasic(prId, userId);
      const meta = yield* github.prs.meta(repo.fullName, pr.externalId, token);

      const cached = yield* walkthroughService.getCached(pr.id, meta.headSha);
      if (cached) {
        return {
          cached: true as const,
          status: "complete" as const,
          walkthrough: cached,
        };
      }

      const partial = yield* walkthroughService.getPartial(pr.id, meta.headSha);
      if (partial && partial.status === "generating") {
        const { opencodeSessionId: _ignored, status: _status, ...walkthrough } = partial;
        return {
          cached: true as const,
          status: "generating" as const,
          walkthrough,
        };
      }

      // No local row — probe the team cache. On a hit, import + complete
      // the row in one shot so the client renders immediately without
      // needing a Generate click or an SSE round-trip.
      const hydrated = yield* jobs.tryHydrateFromRemoteCache(pr.id, meta.headSha, repo.fullName);
      if (hydrated) {
        const fromCache = yield* walkthroughService.getCached(pr.id, meta.headSha);
        if (fromCache) {
          return {
            cached: true as const,
            status: "complete" as const,
            walkthrough: fromCache,
          };
        }
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
 * for a walkthrough that the user previously stopped OR that errored out.
 *
 * Two source states feed this endpoint:
 *
 *   • `status='generating'` — user clicked Stop. The SSE was aborted but the
 *     DB row was never transitioned; boot-time `resumePending()` would have
 *     picked it up too. Just relaunch.
 *
 *   • `status='error'`     — generation failed (e.g. MAX_AUTO_CONTINUATIONS
 *     exhausted before Phase D, or `resumeAttempts` exceeded
 *     `WALKTHROUGH_MAX_RESUME_ATTEMPTS`). We REVIVE the row first via the
 *     orchestrator: transition status back to 'generating' AND reset
 *     `resumeAttempts` to 0 so the user gets a fresh budget. Without the
 *     revive, `createPartial` inside `startJob` recycles 'error' rows by
 *     deleting them — exactly the opposite of "resume from where it left
 *     off". With the revive, the partial content (summary, blocks, issues,
 *     ratings already persisted by MCP tools) is preserved and the agent
 *     reads `get_walkthrough_state` on its first call to pick up where it
 *     stopped.
 *
 * 404 when no resumable row exists — the partial was superseded by a
 * head-SHA advance or never created. Regenerate is the right next action.
 */
export function resumeWalkthroughHandler(prId: string): Promise<{ walkthroughId: string }> {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const jobs = yield* WalkthroughJobs;
      const service = yield* WalkthroughService;
      const row = yield* service.findResumable(prId);
      if (!row) {
        return yield* Effect.fail(new NotFoundError({ resource: "walkthrough", id: prId }));
      }
      if (row.status === "error") {
        yield* jobs.reviveFromError(row.id);
      }
      return yield* jobs.startJob({
        prId,
        userId: "single-user",
        trigger: "resume",
        walkthroughId: row.id,
      });
    }),
  );
}
