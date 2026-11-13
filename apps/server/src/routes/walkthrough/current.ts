import type { WalkthroughMode } from "@revv/shared";
import { Effect } from "effect";
import { PrContextService } from "../../services/PrContext";
import { walkthroughPerspective } from "../../services/walkthrough/perspective";
import { WalkthroughService } from "../../services/walkthrough/Walkthrough";
import { WalkthroughJobs } from "../../services/walkthrough/WalkthroughJobs";

/**
 * GET /api/reviews/:id/walkthrough/current — full current state for the PR.
 *
 * Four response shapes:
 *   • `status: 'complete'`   → finished walkthrough; client renders immediately,
 *                              no SSE needed. May include `stale: true` when
 *                              it is the latest historical walkthrough rather
 *                              than a walkthrough for the current PR HEAD.
 *   • `status: 'generating'` → in-flight job; client hydrates partial content
 *                              and applies later SSE events past `seqAt`.
 *   • `status: 'error'`      → terminal failure; client shows error UI with
 *                              whatever partial content was persisted.
 *   • `status: 'not_found'`  → no local row; client probes the Generate button.
 *                              (Team cache is probed internally before returning
 *                              not_found, so a cache hit returns `complete`.)
 *                              Carries the perspective Generate should default to.
 *
 * `mode` is optional; without it the server picks `walkthroughPerspective`.
 *
 * The head SHA is the locally-synced `pr.headSha`, never a live GitHub call:
 * this read must not depend on GitHub being reachable, or a rate limit,
 * expired token or network blip strands a complete walkthrough behind the
 * "Generate" empty state on reload. It is also the SHA the diff view loads
 * against. Noticing new commits is the PollScheduler's job.
 */
export function currentWalkthrough(prId: string, requestedMode?: WalkthroughMode) {
  return Effect.gen(function* () {
    const prContext = yield* PrContextService;
    const walkthroughService = yield* WalkthroughService;
    const jobs = yield* WalkthroughJobs;

    const { pr } = yield* prContext.readPr(prId);
    const mode = requestedMode ?? (yield* walkthroughPerspective(pr.id));
    const headSha = pr.headSha;
    // No synced head SHA → nothing to match a walkthrough against. The PR
    // row hasn't fully synced yet; the client shows the Generate button and
    // a later `prs:updated` + component-mount re-hydration recovers.
    if (!headSha) return { status: "not_found" as const, mode };

    const complete = yield* walkthroughService.getCached(pr.id, headSha, mode);
    if (complete) {
      const seqAt = yield* walkthroughService.getSeqAt(complete.id);
      return {
        status: "complete" as const,
        walkthrough: complete,
        seqAt,
      };
    }

    const partial = yield* walkthroughService.getPartial(pr.id, headSha, mode);
    if (partial) {
      const seqAt = yield* walkthroughService.getSeqAt(partial.id);
      return {
        status: partial.status,
        walkthrough: partial,
        seqAt,
      };
    }

    // No local row: a teammate's review of this head may be in the team cache.
    if (yield* jobs.importFromTeamCache(pr.id, mode)) {
      const fromCache = yield* walkthroughService.getCached(pr.id, headSha, mode);
      if (fromCache) {
        const seqAt = yield* walkthroughService.getSeqAt(fromCache.id);
        return {
          status: "complete" as const,
          walkthrough: fromCache,
          seqAt,
        };
      }
    }

    // New commits have invalidated the latest generated row, but the user has
    // not started the incremental walkthrough yet. Keep the last reviewed
    // artifact visible and mark it stale so the action bar offers "Review new
    // commits" instead of making the page feel empty.
    const latest = yield* walkthroughService.getLatestDisplayable(pr.id, mode);
    if (latest && latest.prHeadSha !== headSha) {
      const seqAt = yield* walkthroughService.getSeqAt(latest.id);
      return {
        status: "complete" as const,
        walkthrough: latest,
        seqAt,
        stale: true as const,
      };
    }

    return { status: "not_found" as const, mode };
  });
}
