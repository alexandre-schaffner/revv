import { Effect } from "effect";
import { Elysia } from "elysia";
import { AppRuntime } from "../runtime";
import { CacheService } from "../services/Cache";
import { FileContentService } from "../services/FileContent";
import { GitHubEtagCache } from "../services/GitHubEtagCache";
import { withAuth } from "./middleware";

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
      return new Response(
        JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  });
