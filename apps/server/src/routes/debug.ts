import { Effect } from "effect";
import { Elysia } from "elysia";
import { clearSpans, readSpans, summarizeSpans } from "../observability/tracer";
import { AppRuntime } from "../runtime";
import { CacheService } from "../services/Cache";
import { FileContentService } from "../services/FileContent";
import { GitHubEtagCache } from "../services/GitHubEtagCache";
import { WalkthroughJobs } from "../services/WalkthroughJobs";
import { jsonResponse, withAuth } from "./middleware";

/**
 * Dev-only cache inspection endpoint.
 * Gated on DEV mode or REVV_DEBUG=1 environment variable.
 */
export const debugRoutes = new Elysia({ prefix: "/api/_debug" })
  .use(withAuth)
  .get("/cache", async () => {
    if (!import.meta.env?.DEV && process.env.REVV_DEBUG !== "1") {
      return new Response("Not found", { status: 404 });
    }

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
    if (!import.meta.env?.DEV && process.env.REVV_DEBUG !== "1") {
      return new Response("Not found", { status: 404 });
    }

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
    if (!import.meta.env?.DEV && process.env.REVV_DEBUG !== "1") {
      return new Response("Not found", { status: 404 });
    }

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
  .post("/traces/clear", () => {
    if (!import.meta.env?.DEV && process.env.REVV_DEBUG !== "1") {
      return new Response("Not found", { status: 404 });
    }

    clearSpans();
    return { ok: true };
  });
