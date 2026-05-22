// ── Global SSE event stream ─────────────────────────────────────────────────
//
// Owns the long-lived `EventSource` to `GET /api/events?token=…` for the
// authenticated session. Replaces the per-PR walkthrough SSE — walkthrough
// events now arrive on this single connection regardless of which PR the
// user is viewing.
//
// Why SSE (not WS): `EventSource` provides free reconnect with
// `Last-Event-ID`. We don't use the server-side replay (no event buffer —
// reconciliation happens via REST snapshots), but we still get automatic
// reconnect-on-disconnect and a one-directional channel that matches the
// access pattern (server pushes only).
//
// Auth: `?token=` query param. `EventSource` cannot set custom headers,
// so we mirror the pattern used by the WS route. Token is the same bearer
// the WS uses today.

import type { ServerEventMessage } from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { hydrateActiveWalkthroughs, onWalkthroughEvent } from "./walkthrough.svelte";

let source: EventSource | null = null;
let activeHostOverride: string | null = null;

/**
 * Open the global SSE stream for the given bearer token. Closes any
 * existing connection first. Called from `auth.svelte.ts` on sign-in /
 * account-switch, parallel to `ws.connect`.
 *
 * `hostOverride` mirrors the WS connect path: when account-switch hands
 * us a specific host the local settings store is still empty for, we
 * pass it explicitly so the server binds the connection to the right
 * account on the first attempt.
 */
export function connect(token: string, hostOverride?: string): void {
  if (source) {
    disconnect();
  }
  if (hostOverride !== undefined) activeHostOverride = hostOverride;
  const host = activeHostOverride;
  const hostParam = host ? `&host=${encodeURIComponent(host)}` : "";
  const url = `${API_BASE_URL}/api/events?token=${encodeURIComponent(token)}${hostParam}`;
  const es = new EventSource(url);
  source = es;

  es.addEventListener("open", () => {
    // On (re)connect: seed sidebar + lastSeenSeq cursors for any
    // in-flight walkthroughs the user wasn't watching. Best-effort —
    // failures here mean the sidebar spinner shows up late, not data loss.
    void hydrateActiveWalkthroughs();
  });

  es.addEventListener("error", () => {
    // EventSource auto-reconnects on transient failures (its built-in
    // backoff). We don't manually reconnect because that would race the
    // browser's retry. If `readyState === CLOSED` after a hard failure,
    // the next sign-in / account-switch will create a fresh source.
  });

  es.addEventListener("message", (event: MessageEvent<string>) => {
    let msg: ServerEventMessage;
    try {
      msg = JSON.parse(event.data) as ServerEventMessage;
    } catch (err) {
      console.warn("[events] malformed message:", err);
      return;
    }
    dispatch(msg);
  });
}

function dispatch(msg: ServerEventMessage): void {
  if (msg.type === "walkthrough:event") {
    onWalkthroughEvent(msg.data.prId, msg.data.walkthroughId, msg.data.seq, msg.data.event);
    return;
  }
  // `ServerEventMessage` currently has a single variant; once more
  // subsystems migrate off the WS this becomes an exhaustive switch.
  console.warn("[events] unhandled message", (msg as { type: string }).type);
}

export function disconnect(): void {
  if (source) {
    source.close();
    source = null;
  }
  activeHostOverride = null;
}
