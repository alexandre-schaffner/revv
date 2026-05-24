import { treaty } from "@elysiajs/eden";
import type { App } from "@revv/server";
import { API_BASE_URL } from "$lib/api/base-url";
import { tracedAsync } from "$lib/observability";
import { recordSpan } from "$lib/observability/tracer";
import { authHeaders } from "$lib/utils/session-token";

// ── Instrumented fetch wrapper ──────────────────────────────────────────────
//
// Wrap the global `fetch` with a timing span so every Eden request is
// recorded in the observability ring buffer + `api.request.duration`
// histogram. Path is reduced to a coarse template (host + first 3 path
// segments) so we don't blow up the histogram cardinality with per-prId
// or per-walkthroughId variants.

function pathTemplate(input: RequestInfo | URL): string {
  try {
    const url =
      typeof input === "string"
        ? new URL(input, typeof window !== "undefined" ? window.location.origin : API_BASE_URL)
        : input instanceof URL
          ? input
          : new URL(input.url);
    // Keep the first three segments — enough to identify the endpoint
    // group without leaking ids.
    const segments = url.pathname.split("/").filter(Boolean).slice(0, 4);
    return `${url.host}/${segments.join("/")}`;
  } catch {
    return "unknown";
  }
}

const instrumentedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const method = (init?.method ?? "GET").toUpperCase();
  const path = pathTemplate(input);
  const start = performance.now();
  return fetch(input, init)
    .then((res) => {
      const dur = performance.now() - start;
      recordSpan(
        "api.request",
        start,
        dur,
        { method, path, status: res.status, statusClass: `${Math.floor(res.status / 100)}xx` },
        res.ok ? null : new Error(`HTTP ${res.status}`),
      );
      return res;
    })
    .catch((err: unknown) => {
      const dur = performance.now() - start;
      recordSpan("api.request", start, dur, { method, path, status: 0, statusClass: "err" }, err);
      throw err;
    });
};

export const api = treaty<App>(API_BASE_URL, {
  fetch: {
    credentials: "include",
  },
  // Cast: Eden types `fetcher` as `typeof fetch`, which in Bun's env types
  // requires a static `preconnect` method we have no use for. Our wrapper
  // is functionally a `fetch` — the call-site signature matches.
  fetcher: instrumentedFetch as unknown as typeof fetch,
  headers: () => authHeaders(),
});

/**
 * Convenience wrapper for ad-hoc `fetch` calls outside Eden. The store layer
 * uses plenty of these (walkthrough start/abort, hydrateFromCache, etc.).
 * Captures the same `api.request` span shape.
 */
export function tracedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  attrs?: Record<string, unknown>,
): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const path = pathTemplate(input);
  return tracedAsync("api.request", { method, path, ...attrs }, async () => {
    const res = await fetch(input, init);
    return res;
  });
}
