import { Effect } from "effect";
import { Elysia } from "elysia";
import { clearCalls, readCalls } from "../observability/github-ledger/record";
import { selectCalls } from "../observability/github-ledger/select";
import { clearSpans, readSpans, summarizeSpans } from "../observability/tracer";
import { AppRuntime } from "../runtime";
import { CacheService } from "../services/Cache";
import { FileContentService } from "../services/FileContent";
import { GitHubEtagCache } from "../services/GitHubEtagCache";
import { WalkthroughJobs } from "../services/WalkthroughJobs";
import { jsonResponse, withAuth } from "./middleware";

/**
 * Dev-only inspection endpoints.
 * Gated on DEV mode or REVV_DEBUG=1 environment variable.
 */
export const debugRoutes = new Elysia({ prefix: "/api/_debug" })
  .use(withAuth)
  .onBeforeHandle(() => {
    if (!import.meta.env?.DEV && process.env.REVV_DEBUG !== "1") {
      return new Response("Not found", { status: 404 });
    }
  })
  .get("/cache", async () => {
    try {
      const stats = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const cache = yield* CacheService;
          const etagCache = yield* GitHubEtagCache;
          const fileContent = yield* FileContentService;

          const kvStats = yield* cache.stats();
          const etagStats = etagCache.stats();
          const fileStats = fileContent.stats();

          return {
            kv: kvStats,
            github: etagStats,
            fileContent: fileStats,
          };
        }),
      );

      return stats;
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  })
  .get("/mcp-token/:walkthroughId", async ({ params }) => {
    try {
      const token = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const jobs = yield* WalkthroughJobs;
          return yield* jobs.issueSessionToken(params.walkthroughId);
        }),
      );

      return { token };
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  })
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
  // The GitHub calls still in memory. `since` (seconds, or an ISO time) and
  // `origin` (substring) narrow them; `bun run github:audit` does the analysis.
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
