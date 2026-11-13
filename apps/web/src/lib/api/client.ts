import { treaty } from "@elysiajs/eden";
import type { App } from "@revv/server";
import { API_BASE_URL } from "$lib/api/base-url";
import { authHeaders } from "$lib/session/token.svelte";

// `parseDate: false`: Eden would otherwise revive every ISO-looking string into
// a `Date`, while the route types, the shared DTOs and the SSE stream all say
// `string`. No route types a `Date` in its response, so the wire's strings are
// what every caller reads.
export const api = treaty<App>(API_BASE_URL, {
  fetch: {
    credentials: "include",
  },
  headers: () => authHeaders(),
  parseDate: false,
});
