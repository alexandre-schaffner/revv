// ── Web RUM (dev-only) ───────────────────────────────────────────────────────
//
// Real-user-monitoring spans for the SvelteKit frontend, exported to the local
// telemetry collector. Loaded *only* in dev (see hooks.client.ts) via dynamic
// import, so none of the OpenTelemetry browser SDK reaches the production
// desktop bundle.
//
// We keep instrumentation deliberately small: a document-load span and a thin
// fetch wrapper for API calls. The exporter's own request and the long-lived
// SSE stream are excluded so RUM never instruments itself into a feedback loop.

import { type Span, SpanKind, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { COLLECTOR_BASE_URL } from "@revv/shared";

const TRACES_URL = `${COLLECTOR_BASE_URL}/v1/traces`;
let started = false;

export function initRum(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({ "service.name": "revv-web" }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: TRACES_URL }))],
  });
  provider.register();

  const tracer = trace.getTracer("revv-web");
  emitDocumentLoad(tracer);
  instrumentFetch(tracer);
}

/** One span describing the initial document load, from navigation timing. */
function emitDocumentLoad(tracer: Tracer): void {
  const emit = (): void => {
    const [nav] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    if (!nav || nav.loadEventEnd <= 0) return;
    const origin = performance.timeOrigin;
    const span = tracer.startSpan("document.load", {
      kind: SpanKind.INTERNAL,
      startTime: origin + nav.startTime,
      attributes: {
        "url.path": location.pathname,
        "http.response.status_code": nav.responseStatus || undefined,
        "dom.content_loaded_ms": Math.round(nav.domContentLoadedEventEnd - nav.startTime),
        "dom.interactive_ms": Math.round(nav.domInteractive - nav.startTime),
      },
    });
    span.end(origin + nav.loadEventEnd);
  };

  if (document.readyState === "complete") emit();
  else window.addEventListener("load", () => setTimeout(emit, 0), { once: true });
}

/** Wrap window.fetch to emit a client span per request (excluding telemetry). */
function instrumentFetch(tracer: Tracer): void {
  const original = window.fetch.bind(window);

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    // Don't instrument the exporter's own POST or the long-lived SSE stream.
    if (url.startsWith(COLLECTOR_BASE_URL) || url.includes("/api/events")) {
      return original(input, init);
    }

    let path = url;
    try {
      path = new URL(url, location.href).pathname;
    } catch {
      // keep the raw url
    }

    const span: Span = tracer.startSpan(`HTTP ${method} ${path}`, {
      kind: SpanKind.CLIENT,
      attributes: { "http.request.method": method, "url.path": path },
    });
    try {
      const res = await original(input, init);
      span.setAttribute("http.response.status_code", res.status);
      if (!res.ok) span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.status}` });
      return res;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : "fetch failed",
      });
      throw err;
    } finally {
      span.end();
    }
  };

  // The wrapper covers the call signature; `typeof fetch` also carries the
  // `preconnect` static the DOM lib added, which a plain function lacks.
  window.fetch = wrapped as typeof window.fetch;
}
