// ── Revv telemetry collector ─────────────────────────────────────────────────
//
// A dev-only, standalone OTLP sink + query API + dashboard host. One Elysia app
// on COLLECTOR_PORT serves four roles on a single port:
//
//   POST /v1/traces   OTLP/HTTP JSON ingest (every Revv process exports here)
//   GET  /api/*       windowed query endpoints backing the dashboard
//   GET  /events      SSE signal stream (`perf:updated` after each ingest batch)
//   GET  /*           the static dashboard SPA (production build)
//
// Nothing here is wired into the installer or prod packaging — it exists only
// under `make dev-desktop`.

import { join } from "node:path";
import { cors } from "@elysiajs/cors";
import { COLLECTOR_PORT } from "@revv/shared";
import { Elysia } from "elysia";
import { broadcast, openStream } from "./sse";
import { TelemetryStore } from "./store";

const DB_PATH = process.env.COLLECTOR_DB_PATH ?? join(import.meta.dir, "..", "collector.duckdb");
const DIST_DIR = join(import.meta.dir, "..", "web", "dist");
const PRUNE_INTERVAL_MS = 5 * 60_000;

// ── Single-instance guard (keyed on the DB path) ─────────────────────────────
const { acquireSingleInstance } = await import("./singleInstance");
const releasePidFile = acquireSingleInstance(`${DB_PATH}.collector.pid`);

const store = await TelemetryStore.open(DB_PATH);

// ── Windowed-query helpers ───────────────────────────────────────────────────

interface Window {
  sinceMs: number;
  bucketMs: number;
  service: string | undefined;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function parseWindow(query: Record<string, string | undefined>): Window {
  const windowMinutes = clamp(Number(query.window) || 60, 1, 24 * 60);
  const windowMs = windowMinutes * 60_000;
  // Aim for ~60 buckets across the window, snapped to a sane floor/ceiling.
  const bucketMs = clamp(Math.round(windowMs / 60), 5_000, 5 * 60_000);
  const service = query.service && query.service !== "all" ? query.service : undefined;
  return { sinceMs: Date.now() - windowMs, bucketMs, service };
}

const limitOf = (query: Record<string, string | undefined>, fallback: number): number =>
  clamp(Number(query.limit) || fallback, 1, 500);

// ── Static SPA serving (production build; dev runs Vite on :5174) ────────────

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  woff2: "font/woff2",
  woff: "font/woff",
  ico: "image/x-icon",
  png: "image/png",
  map: "application/json; charset=utf-8",
};

function contentType(name: string): string {
  return MIME[name.split(".").pop() ?? ""] ?? "application/octet-stream";
}

async function serveStatic(path: string): Promise<Response> {
  const clean = path.replace(/^\/+/, "") || "index.html";
  const file = Bun.file(join(DIST_DIR, clean));
  // Bun doesn't always infer a Content-Type here, and browsers enforce strict
  // MIME checking on ES module scripts — set it explicitly from the extension.
  if (await file.exists()) {
    return new Response(file, { headers: { "content-type": contentType(clean) } });
  }
  // SPA fallback: unknown non-asset routes resolve to index.html.
  const index = Bun.file(join(DIST_DIR, "index.html"));
  if (await index.exists()) {
    return new Response(index, { headers: { "content-type": contentType("index.html") } });
  }
  return new Response(
    "Revv telemetry collector is running.\n\nThe dashboard SPA isn't built yet — run `bun run --filter @revv/collector dev:web` and open http://localhost:5174, or `bun run build` to bundle it here.\n",
    { status: 200, headers: { "Content-Type": "text/plain" } },
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

const app = new Elysia()
  .use(
    cors({
      origin: true, // dev-only, localhost; every Revv surface may export/query
      allowedHeaders: ["Content-Type"],
      methods: ["GET", "POST", "OPTIONS"],
    }),
  )
  // OTLP/HTTP JSON ingest. Commit to DuckDB first, then signal the dashboard.
  .post("/v1/traces", async ({ body, set }) => {
    try {
      const { accepted, latestMs } = await store.ingestOtlp(body);
      if (accepted > 0) broadcast({ type: "perf:updated", data: { ingested: accepted, latestMs } });
    } catch (err) {
      console.error("[collector] ingest failed:", err);
    }
    // OTLP expects a 200 with an (empty) ExportTraceServiceResponse.
    set.headers["content-type"] = "application/json";
    return { partialSuccess: {} };
  })
  // ── Query API ──
  .get("/api/kpis", ({ query }) => {
    const w = parseWindow(query);
    return store.kpis({ sinceMs: w.sinceMs, service: w.service });
  })
  .get("/api/summary", ({ query }) => {
    const w = parseWindow(query);
    return store.operationSummary({
      sinceMs: w.sinceMs,
      service: w.service,
      includeNoise: query.includeNoise === "1" || query.includeNoise === "true",
    });
  })
  .get("/api/categories", ({ query }) => {
    const w = parseWindow(query);
    return store.categories({ sinceMs: w.sinceMs });
  })
  .get("/api/timeseries", ({ query }) => {
    const w = parseWindow(query);
    return store.timeseries({ sinceMs: w.sinceMs, bucketMs: w.bucketMs, service: w.service });
  })
  .get("/api/timeseries/services", ({ query }) => {
    const w = parseWindow(query);
    return store.serviceTimeseries({ sinceMs: w.sinceMs, bucketMs: w.bucketMs });
  })
  .get("/api/slow", ({ query }) => {
    const w = parseWindow(query);
    return store.slowestSpans({
      sinceMs: w.sinceMs,
      limit: limitOf(query, 12),
      service: w.service,
    });
  })
  .get("/api/errors", ({ query }) => {
    const w = parseWindow(query);
    return store.errorSpans({ sinceMs: w.sinceMs, limit: limitOf(query, 25), service: w.service });
  })
  .get("/api/traces", ({ query }) => {
    const w = parseWindow(query);
    return store.recentTraces({
      sinceMs: w.sinceMs,
      limit: limitOf(query, 30),
      service: w.service,
    });
  })
  .get("/api/trace/:id", ({ params }) => store.traceSpans(params.id))
  .get("/api/services", ({ query }) => {
    const w = parseWindow(query);
    return store.services({ sinceMs: w.sinceMs });
  })
  // ── SSE ──
  .get("/events", ({ request }) => openStream(request.signal))
  // ── Static dashboard (catch-all, last) ──
  .get("/", () => serveStatic("index.html"))
  .get("/*", ({ params }) => serveStatic(params["*"] ?? ""))
  .listen(COLLECTOR_PORT);

console.error(`[collector] listening on http://localhost:${COLLECTOR_PORT} (db: ${DB_PATH})`);

// ── Periodic retention prune ─────────────────────────────────────────────────
const pruneTimer = setInterval(() => {
  store.prune().catch((err) => console.error("[collector] prune failed:", err));
}, PRUNE_INTERVAL_MS);
pruneTimer.unref();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  console.error(`[collector] ${signal} received — shutting down…`);
  const hardKill = setTimeout(() => process.exit(1), 5000);
  hardKill.unref();
  try {
    app.stop();
  } catch {}
  clearInterval(pruneTimer);
  store.close();
  releasePidFile();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
