import type { WalkthroughMode } from "@revv/shared";
import { Effect } from "effect";
import { AppRuntime } from "../../../runtime";
import { PrContextService } from "../../../services/PrContext";
import { WalkthroughService } from "../../../services/Walkthrough";
import { WalkthroughJobs } from "../../../services/WalkthroughJobs";

/**
 * GET /api/reviews/:id/walkthrough/current — full current state for any
 * non-superseded walkthrough at the PR's HEAD SHA.
 *
 * Four response shapes:
 *   • `status: 'complete'`   → finished walkthrough; client renders immediately,
 *                              no SSE needed.
 *   • `status: 'generating'` → in-flight job; client hydrates partial content
 *                              and opens SSE from `snapshotAt` cursor so only
 *                              race-window events arrive over the wire.
 *   • `status: 'error'`      → terminal failure; client shows error UI with
 *                              whatever partial content was persisted.
 *   • `status: 'not_found'`  → no local row; client probes the Generate button.
 *                              (Team cache is probed internally before returning
 *                              not_found, so a cache hit returns `complete`.)
 *
 * The `snapshotAt` field is a cursor anchor: when the client opens the SSE
 * stream with `?snapshotAt=<value>`, the server replays only rows created
 * after that timestamp, avoiding a full retransmission of already-hydrated
 * content.
 *
 * `opencodeSessionId` is stripped before returning — it's an orchestrator
 * credential, not something the UI consumes.
 *
 * The head SHA is read from the locally-synced PR row (`pr.headSha`), NOT a
 * live GitHub call. This endpoint serves locally-cached content and must not
 * depend on GitHub being reachable — a live `prs.meta()` call here meant any
 * rate-limit (429), expired token (401), or network blip threw before the DB
 * was even consulted, stranding a perfectly good complete walkthrough behind
 * the "Generate" empty state on reload. `pr.headSha` is also the exact SHA the
 * diff view loads against, so the walkthrough stays consistent with the diff;
 * new-commit detection / superseding is the PollScheduler's job, not this
 * read path's. (Doctrine: SQLite is authoritative.)
 */
export function getCurrentWalkthroughHandler(
  prId: string,
  userId: string,
  mode: WalkthroughMode = "reviewer",
) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const prContext = yield* PrContextService;
      const walkthroughService = yield* WalkthroughService;
      const jobs = yield* WalkthroughJobs;

      const { pr, repo } = yield* prContext.resolveBasic(prId, userId);
      const headSha = pr.headSha;
      // No synced head SHA → nothing to match a walkthrough against. The PR
      // row hasn't fully synced yet; the client shows the Generate button and
      // a later `prs:updated` + component-mount re-hydration recovers.
      if (!headSha) return { status: "not_found" as const };

      // 1. Complete walkthrough — best case, no SSE needed.
      const complete = yield* walkthroughService.getCached(pr.id, headSha, mode);
      if (complete) {
        const seqAt = yield* walkthroughService.getSeqAt(complete.id);
        return {
          status: "complete" as const,
          walkthrough: complete,
          snapshotAt: new Date().toISOString(),
          seqAt,
        };
      }

      // 2. In-progress or errored walkthrough — hydrate partial state.
      const partial = yield* walkthroughService.getPartial(pr.id, headSha, mode);
      if (partial) {
        const { opencodeSessionId: _ignored, ...walkthrough } = partial;
        const seqAt = yield* walkthroughService.getSeqAt(walkthrough.id);
        return {
          status: partial.status as "generating" | "error",
          walkthrough,
          snapshotAt: new Date().toISOString(),
          seqAt,
        };
      }

      // 3. No local row — probe the team cache. On a hit the cache importer
      //    creates a complete row, so we re-query and return it as complete.
      const hydrated = yield* jobs.tryHydrateFromRemoteCache(pr.id, headSha, repo.fullName, mode);
      if (hydrated) {
        const fromCache = yield* walkthroughService.getCached(pr.id, headSha, mode);
        if (fromCache) {
          const seqAt = yield* walkthroughService.getSeqAt(fromCache.id);
          return {
            status: "complete" as const,
            walkthrough: fromCache,
            snapshotAt: new Date().toISOString(),
            seqAt,
          };
        }
      }

      return { status: "not_found" as const };
    }),
  );
}
