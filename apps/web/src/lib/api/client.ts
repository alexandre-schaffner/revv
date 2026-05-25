import { treaty } from "@elysiajs/eden";
import type { App } from "@revv/server";
import { API_BASE_URL } from "$lib/api/base-url";
import { tracedAsyncWith } from "$lib/observability";
import { authHeaders } from "$lib/utils/session-token";

// ── Instrumented fetch wrapper ──────────────────────────────────────────────
//
// Wrap the global `fetch` with an `api.request` span. Path is reduced to a
// coarse template (host + first 3 segments) so per-id variants don't blow up
// the histogram cardinality. Status + status class are stamped on the span
// at completion via `tracedAsyncWith` so the recorder sees them.

function pathTemplate(input: RequestInfo | URL): string {
  try {
    const url =
      typeof input === "string"
        ? new URL(input, typeof window !== "undefined" ? window.location.origin : API_BASE_URL)
        : input instanceof URL
          ? input
          : new URL(input.url);
    const segments = url.pathname.split("/").filter(Boolean).slice(0, 4);
    return `${url.host}/${segments.join("/")}`;
  } catch {
    return "unknown";
  }
}

const instrumentedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const method = (init?.method ?? "GET").toUpperCase();
  const path = pathTemplate(input);
  return tracedAsyncWith("api.request", { method, path }, async () => {
    const res = await fetch(input, init);
    return {
      value: res,
      attrs: { status: res.status, statusClass: `${Math.floor(res.status / 100)}xx` },
    };
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
