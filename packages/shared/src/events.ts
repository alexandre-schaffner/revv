// ── Global event stream (SSE) envelopes ─────────────────────────────────────
//
// Server → client messages delivered over the long-lived `GET /api/events`
// SSE connection. One stream per client tab, lifetime = session.
//
// The intent over time is to migrate every real-time server push onto this
// channel (currently split across the WS and per-PR walkthrough SSE).
// This file defines the union; envelopes can be added incrementally as
// each subsystem migrates. The walkthrough subsystem is the first migrant —
// the rest stay on the WS for now and will land in follow-up PRs.

import type { WalkthroughStreamEvent } from "./walkthrough";

/**
 * Per-event envelope for walkthrough content + lifecycle. Replaces the
 * legacy per-PR walkthrough SSE stream and the four standalone WS
 * lifecycle envelopes (`walkthrough:complete`, `walkthrough:error`,
 * `walkthrough:cache-hit`, `walkthrough:edited`).
 *
 *   prId           — the PR this walkthrough belongs to (route key on the
 *                    client; entries are stored by prId for sidebar +
 *                    detail-view consumption regardless of active page).
 *   walkthroughId  — DB row id; used to scope `lastSeenSeq` cursors so the
 *                    cursor naturally resets across regenerate/supersede
 *                    boundaries.
 *   seq            — monotonic per-walkthrough counter sourced from
 *                    `walkthroughs.next_seq` (atomic with content writes).
 *                    Client drops envelopes with `seq <= lastSeenSeq` for
 *                    the in-flight reconnect race. See SSE-rewrite plan §4.2.
 *   event          — the actual payload (content event, lifecycle event,
 *                    or chat-edit deletion). Same union the legacy SSE used,
 *                    extended with `lifecycle:*` variants.
 */
export interface WalkthroughEventEnvelope {
  type: "walkthrough:event";
  data: {
    prId: string;
    walkthroughId: string;
    seq: number;
    event: WalkthroughStreamEvent;
  };
}

/**
 * Server → client message union for the global SSE stream. Extend as
 * subsystems migrate off the WS.
 */
export type ServerEventMessage = WalkthroughEventEnvelope;
