# Walkthrough SSE Unification — Deferred Follow-Ups

Tracked from `alexandre-schaffner/rethink-walkthrough-streaming` review ("Merge with follow-up notes").

## Bugs (fix before GA)

### B-001 — Async deregister gap leaks SSE writer on early disconnect
- **File:** `apps/server/src/routes/events.ts:44-47`
- **Issue:** `register(writer)` returns a Promise; `deregister` is only assigned in `.then()`. If the client disconnects before the Promise resolves, `tearDown()` runs with `deregister === null` — the writer is never removed from the `Ref<Set>`, leaking memory and causing spurious errors on subsequent `broadcastToAccount` calls.
- **Fix:** Make registration synchronous (e.g. `registerSync` via `Ref.update` + `Effect.runSync`) so `deregister` is available before `start()` returns.

### B-002 — `Math.max(0, nextSeq-1)` clamp drops seq=0 lifecycle events
- **File:** `apps/server/src/services/Walkthrough.ts:29-30` (getSeqAt) and line ~893 (listActiveForAccount)
- **Issue:** `getSeqAt` returns `Math.max(0, nextSeq-1)`. When `nextSeq=0` (fresh walkthrough), this returns 0. The client sets `lastSeenSeq[wtId] = 0` and then drops the first event with `seq=0` because `0 <= 0` is true.
- **Fix:** Remove the `Math.max(0, ...)` clamp — return `nextSeq - 1` directly (allowing -1). Client cursor defaults to -1, so `seq=0` passes the dedup check.

### B-003 — `lifecycle:complete` missing on no-auto-continuation path
- **File:** `apps/server/src/services/WalkthroughJobs.ts:895-903`
- **Issue:** When `buildContinuationEffect()` returns `{ _tag: "none" }` (agent finished cleanly), only the legacy `done` event is emitted — never the new `lifecycle:complete`. Clients relying on `lifecycle:complete` as the canonical completion signal will not see it for the majority of walkthroughs.
- **Fix:** Emit `lifecycle:complete` (with `Effect.catchAll(() => Effect.void)`) before or alongside `done` on this branch.

## Deferred Cleanup

### C-001 — Remove legacy per-PR SSE `fanOut` path
- **Description:** The dual-emit cutover keeps `fanOut` running alongside the new `EventBus`. Once the client cutover is proven stable, the per-PR SSE handler and all `fanOut` machinery should be deleted atomically.

### C-002 — SSR prerender import removal in PrerenderCache.ts
- **Description:** Walkthrough code-block SSR prerender import noted in the diff as no longer needed after the SSE refactor. Separate PR.

### C-003 — Cache-hit replay-as-events
- **Description:** When a walkthrough is already complete and the client hydrates via REST, the events should be replayed through the SSE bus for reducer consistency (so subscribers see the full event sequence rather than just a snapshot). Noted in the diff as deferred.
