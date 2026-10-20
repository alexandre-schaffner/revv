import { Effect } from "effect";
import { Elysia } from "elysia";
import { analyze } from "../observability/github-ledger/analyze";
import { formatReport, formatTimeline } from "../observability/github-ledger/format";
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
  // The GitHub call ledger, analyzed. `since` (seconds, or an ISO time) and
  // `origin` (substring) narrow it; `format=text` answers what the CLI prints.
  .get("/github", ({ query }) => {
    if (!import.meta.env?.DEV && process.env.REVV_DEBUG !== "1") {
      return new Response("Not found", { status: 404 });
    }
    const calls = selectCalls(readCalls(), {
      since: typeof query.since === "string" ? query.since : null,
      origin: typeof query.origin === "string" ? query.origin : null,
    });
    const report = analyze(calls);
    if (query.format !== "text") return { report, calls };
    const text =
      formatReport(report) + (query.timeline ? `\n\nTIMELINE\n${formatTimeline(calls)}` : "");
    return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  })
  .post("/github/clear", () => {
    if (!import.meta.env?.DEV && process.env.REVV_DEBUG !== "1") {
      return new Response("Not found", { status: 404 });
    }
    clearCalls();
    return { ok: true };
  })
  .post("/traces/clear", () => {
    if (!import.meta.env?.DEV && process.env.REVV_DEBUG !== "1") {
      return new Response("Not found", { status: 404 });
    }

    clearSpans();
    return { ok: true };
  });
