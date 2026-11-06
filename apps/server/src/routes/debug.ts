import { Effect } from "effect";
import { Elysia } from "elysia";
import { serverEnv } from "../config";
import { clearCalls, readCalls } from "../observability/github-ledger/record";
import { selectCalls } from "../observability/github-ledger/select";
import { clearSpans, readSpans, summarizeSpans } from "../observability/tracer";
import { CacheService } from "../services/Cache";
import { GitHubEtagCache } from "../services/GitHubEtagCache";
import { WalkthroughJobs } from "../services/WalkthroughJobs";
import { runRoute, withAuth } from "./middleware";

export const debugRoutes = new Elysia({ prefix: "/api/_debug" })
  .use(withAuth)
  .onBeforeHandle(() => {
    if (!serverEnv.debug) {
      return new Response("Not found", { status: 404 });
    }
  })
  .get("/cache", () =>
    runRoute(
      Effect.gen(function* () {
        const cache = yield* CacheService;
        const etagCache = yield* GitHubEtagCache;
        return { kv: yield* cache.stats(), github: etagCache.stats() };
      }),
    ),
  )
  .get("/mcp-token/:walkthroughId", ({ params }) =>
    runRoute(
      Effect.flatMap(WalkthroughJobs, (jobs) => jobs.issueSessionToken(params.walkthroughId)).pipe(
        Effect.map((token) => ({ token })),
      ),
    ),
  )
  .get("/traces", ({ query }) => {
    const filter: { name?: string | RegExp; minDurationMs?: number } = {};
    if (typeof query.name === "string") {
      filter.name = query.name;
    }
    if (typeof query.minDuration === "string") {
      const n = Number.parseFloat(query.minDuration);
      if (!Number.isNaN(n)) filter.minDurationMs = n;
    }

    return {
      spans: readSpans(filter),
      summary: summarizeSpans(),
    };
  })
  .get("/github", ({ query }) => ({
    calls: selectCalls(readCalls(), {
      since: typeof query.since === "string" ? query.since : null,
      origin: typeof query.origin === "string" ? query.origin : null,
    }),
  }))
  .post("/github/clear", () => {
    clearCalls();
    return { ok: true };
  })
  .post("/traces/clear", () => {
    clearSpans();
    return { ok: true };
  });
