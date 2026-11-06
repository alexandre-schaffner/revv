import { Effect } from "effect";
import { DiffCacheService, toGitHubFileShape } from "../../../services/DiffCache";
import { PrContextService } from "../../../services/PrContext";

/**
 * The PR, its head, and its cached diff, for the previews that run before
 * generation (sizing, first pass). Reads the cache only, never GitHub, so a
 * preview can't become a rate-limit risk; null until the diff lands, which the
 * server announces as `diff:cached`. Auth and not-found fail as usual.
 */
export function loadCachedPrDiff(prId: string) {
  return Effect.gen(function* () {
    const prContext = yield* PrContextService;
    const { pr } = yield* prContext.forPr(prId);
    if (!pr.headSha) return null;
    const diffCache = yield* DiffCacheService;
    const cached = yield* diffCache.getCachedFiles(pr.id);
    if (cached === null) return null;
    return { pr, headSha: pr.headSha, files: toGitHubFileShape(cached) };
  });
}
