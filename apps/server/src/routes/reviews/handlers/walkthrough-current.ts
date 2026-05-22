import { Effect } from "effect";
import { AppRuntime } from "../../../runtime";
import { GitHubService } from "../../../services/GitHub";
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
 */
export function getCurrentWalkthroughHandler(prId: string, userId: string) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const prContext = yield* PrContextService;
      const github = yield* GitHubService;
      const walkthroughService = yield* WalkthroughService;
      const jobs = yield* WalkthroughJobs;

      const { pr, repo, token } = yield* prContext.resolveBasic(prId, userId);
      const meta = yield* github.getPrMeta(repo.fullName, pr.externalId, token);

      // 1. Complete walkthrough — best case, no SSE needed.
      const complete = yield* walkthroughService.getCached(pr.id, meta.headSha);
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
      const partial = yield* walkthroughService.getPartial(pr.id, meta.headSha);
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
      const hydrated = yield* jobs.tryHydrateFromRemoteCache(pr.id, meta.headSha, repo.fullName);
      if (hydrated) {
        const fromCache = yield* walkthroughService.getCached(pr.id, meta.headSha);
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
