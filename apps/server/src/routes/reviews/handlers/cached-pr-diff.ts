import { Effect } from "effect";
import type { FileLike } from "../../../ai/jev/state";
import { DiffCacheService } from "../../../services/DiffCache";
import { PrContextService } from "../../../services/PrContext";

/**
 * The PR, its head, and its cached diff, for the previews that run before
 * generation (sizing, first pass). Reads the cache only, never GitHub, so a
 * preview can't become a rate-limit risk; null until the diff lands, which the
 * client answers by asking again. Auth and not-found fail as usual.
 */
export function loadCachedPrDiff(prId: string, userId: string) {
  return Effect.gen(function* () {
    const prContext = yield* PrContextService;
    const { pr } = yield* prContext.resolveBasic(prId, userId);
    if (!pr.headSha) return null;
    const diffCache = yield* DiffCacheService;
    const cached = yield* diffCache.getCachedFiles(pr.id);
    if (cached === null || cached.length === 0) return null;
    const files: FileLike[] = cached.map((f) => ({
      filename: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    }));
    return { pr, headSha: pr.headSha, files };
  });
}
