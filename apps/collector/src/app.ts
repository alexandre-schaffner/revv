import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import type { TelemetryStore } from "./store";
import { OtlpPayloadError } from "./store/ingest";

const BROWSER_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];
// host.docker.internal is used by Grafana's server-side data source proxy.
const COLLECTOR_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]);

// ── Windowed-query helpers ───────────────────────────────────────────────────

interface Window {
  sinceMs: number;
  bucketMs: number;
  untilMs: number;
  service: string | undefined;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function parseWindow(query: Record<string, string | undefined>): Window {
  const windowMinutes = clamp(Number(query.window) || 60, 1, 30 * 24 * 60);
  const untilMs = Number(query.to) || Date.now();
  const sinceMs = Math.max(
    Number(query.from) || untilMs - windowMinutes * 60_000,
    untilMs - 30 * 24 * 60 * 60_000,
  );
  const windowMs = untilMs - sinceMs;
  // Aim for ~60 buckets across the window, snapped to a sane floor/ceiling.
  const bucketMs = clamp(
    Number(query.bucketMs) || Math.round(windowMs / 60),
    5_000,
    24 * 60 * 60_000,
  );
  const service = query.service && query.service !== "all" ? query.service : undefined;
  return { sinceMs, untilMs, bucketMs, service };
}

const limitOf = (query: Record<string, string | undefined>, fallback: number): number =>
  clamp(Number(query.limit) || fallback, 1, 500);

// ── App ──────────────────────────────────────────────────────────────────────

export function createCollectorApp(store: TelemetryStore, grafanaUrl: string) {
  return (
    new Elysia()
      .use(
        cors({
          origin: BROWSER_ORIGINS,
          credentials: false,
          allowedHeaders: ["Content-Type"],
          methods: ["GET", "POST", "OPTIONS"],
        }),
      )
      .onRequest(({ request }) => {
        const url = new URL(request.url);
        const origin = request.headers.get("origin");
        // CORS alone does not block cross-origin writes or DNS rebinding.
        if (
          !COLLECTOR_HOSTS.has(url.hostname) ||
          (origin !== null && !BROWSER_ORIGINS.includes(origin))
        ) {
          return new Response("Forbidden", { status: 403 });
        }
      })
      .get("/api/health", () => ({ service: "revv-collector" }))
      // OTLP/HTTP JSON ingest. Commit to DuckDB before acknowledging the batch.
      .post("/v1/traces", async ({ body, set }) => {
        try {
          const { rejectedSpans } = await store.ingestOtlp(body);
          return rejectedSpans > 0
            ? {
                partialSuccess: {
                  rejectedSpans: String(rejectedSpans),
                  errorMessage: "Malformed spans were rejected",
                },
              }
            : {};
        } catch (err) {
          if (err instanceof OtlpPayloadError) {
            set.status = 400;
            return { code: 3, message: err.message };
          }
          console.error("[collector] ingest failed:", err);
          set.status = 503;
          set.headers["retry-after"] = "1";
          return { code: 14, message: "Telemetry storage unavailable" };
        }
      })
      // ── Query API ──
      .get("/api/kpis", ({ query }) => {
        const w = parseWindow(query);
        return store.kpis({ sinceMs: w.sinceMs, untilMs: w.untilMs, service: w.service });
      })
      .get("/api/summary", ({ query }) => {
        const w = parseWindow(query);
        return store.operationSummary({
          sinceMs: w.sinceMs,
          untilMs: w.untilMs,
          service: w.service,
          includeNoise: query.includeNoise === "1" || query.includeNoise === "true",
        });
      })
      .get("/api/categories", ({ query }) => {
        const w = parseWindow(query);
        return store.categories({ sinceMs: w.sinceMs, untilMs: w.untilMs });
      })
      .get("/api/timeseries", ({ query }) => {
        const w = parseWindow(query);
        return store.timeseries({
          sinceMs: w.sinceMs,
          untilMs: w.untilMs,
          bucketMs: w.bucketMs,
          service: w.service,
        });
      })
      .get("/api/timeseries/services", ({ query }) => {
        const w = parseWindow(query);
        return store.serviceTimeseries({
          sinceMs: w.sinceMs,
          untilMs: w.untilMs,
          bucketMs: w.bucketMs,
        });
      })
      .get("/api/slow", ({ query }) => {
        const w = parseWindow(query);
        return store.slowestSpans({
          sinceMs: w.sinceMs,
          untilMs: w.untilMs,
          limit: limitOf(query, 12),
          service: w.service,
        });
      })
      .get("/api/errors", ({ query }) => {
        const w = parseWindow(query);
        return store.errorSpans({
          sinceMs: w.sinceMs,
          untilMs: w.untilMs,
          limit: limitOf(query, 25),
          service: w.service,
        });
      })
      .get("/api/traces", ({ query }) => {
        const w = parseWindow(query);
        return store.recentTraces({
          sinceMs: w.sinceMs,
          untilMs: w.untilMs,
          limit: limitOf(query, 30),
          service: w.service,
        });
      })
      .get("/api/generations", ({ query }) => {
        const w = parseWindow(query);
        return store.generations({
          sinceMs: w.sinceMs,
          untilMs: w.untilMs,
          limit: limitOf(query, 40),
          service: w.service,
        });
      })
      .get("/api/trace/:id", ({ params }) => store.traceSpans(params.id))
      .get("/api/services", ({ query }) => {
        const w = parseWindow(query);
        return store.services({ sinceMs: w.sinceMs, untilMs: w.untilMs });
      })
      .get("/", () => Response.redirect(grafanaUrl, 302))
  );
}
