# Robustness Audit — Walkthrough Generation Pipeline

Point-in-time audit of the three load-bearing layers underneath walkthrough generation: the SSE generation stream, the long-lived global SSE bus (`Broadcaster`), and the provider façade that fronts the Claude Agent SDK and opencode. Captured at the start of the "robustness and reliability" arc.

Companion: [`backlog.md`](./backlog.md) — the living punch list. Every gap below carries an id (`S1`, `W3`, `P2`, …) that backlog rows back-reference.

---

## 0. How to read this audit

This audit measures the pipeline against the invariants codified in [`CLAUDE.md`](../../CLAUDE.md#agent-subsystem-invariants):

1. SQLite is authoritative; in-memory state is reconstructible cache.
2. Agent content writes go through MCP only.
3. Each MCP tool call is one atomic idempotent write.
4. Content generation is a strict 4-phase pipeline A→B→C→D.
5. Phase preconditions are tool-level.
6. Resumption reads state via MCP.
7. Walkthroughs are immutable per head SHA during generation (carve-out: chat-edit).
8. Commit first, broadcast second.
9. Bounded retries with explicit budgets.
10. Per-job resource scoping.
11. Status transitions are orchestrator-only.
12. `complete_walkthrough` is a validation gate.
13. Agent-path parity: byte-for-byte identical externally-observable behavior.
14. Agent-daemon lifecycle: eager-start while needed, settings-driven stop, ephemeral credentials.

Each finding row carries two ratings:

- **Severity** — Blocking / High / Medium / Low — independent of arc.
- **Walkthrough impact** — High / Medium / Low — how directly it can break walkthrough generation today.

The backlog sorts by walkthrough impact first, then severity. Rows are tagged `[Sn]`, `[Wn]`, or `[Pn]`.

**Deliberate non-findings** are kept in-document (rather than dropped) so future readers do not re-raise them. They live in their own table and are clearly marked.

**Audit-agent corrections** — places where the sub-audits got something wrong — are also kept in-document, again so the same mistake is not re-introduced.

---

## 1. SSE generation stream

### 1.1 Architecture

The SSE channel carries per-job Phase A→D events from MCP tool handlers to the SvelteKit UI. Three layers:

| Layer | File | Responsibility |
|---|---|---|
| Stream primitives | `apps/server/src/routes/reviews/sse.ts` | `createSseStream()`, 15s heartbeat (`: ping`), idempotent `close`, `send` returns `false` on enqueue throw. |
| Route handler | `apps/server/src/routes/reviews/handlers/walkthrough-stream.ts` | Subscribe → DB snapshot replay → flush buffer → live forward. Replay dedup. |
| Client transport | `apps/web/src/lib/services/walkthrough-sse.ts` + `apps/web/src/lib/stores/walkthrough-stream.svelte.ts` | Fetch + body reader + parser, inactivity (90s) and exploration-stall (3min) guards, abort controller, reconciliation poll on unexpected end. |

Event envelope shape is defined in `packages/shared/src/walkthrough.ts` as the `WalkthroughStreamEvent` union — the same union the global-bus `walkthrough:event` SSE envelope wraps (as `lifecycle:edited`) for the chat-edit carve-out.

### 1.2 Already correct — call out, do not rewrite

| Invariant | Evidence |
|---|---|
| #1 / #8 — DB authoritative, commit-first | SSE handler does DB snapshot replay before live forward; cache hydration always reads DB. (`walkthrough-stream.ts` `subscribe → snapshot → flush → live`.) |
| #7 — Chat-edit carve-out | Post-completion edits go through the `walkthrough:event` SSE envelope (`lifecycle:edited`) on the global bus only. Verified at `apps/server/src/routes/mcp/chat-context.ts` `emit()`. |
| Reconcile on reconnect | Client's `scheduleReconciliationPoll` calls `hydrateFromCache(prId)` on unexpected stream end with exponential backoff. (`walkthrough-stream.svelte.ts:216–252`.) |
| Per-job worktree teardown | Worktree registered as scope finalizer in `WalkthroughJobs`; cleanup runs on every exit path including `kill -9`-style fiber interruption. |
| Strong typing | `WalkthroughStreamEvent` union is shared end-to-end. No `unknown`/`any` widening at the SSE boundary. |

### 1.3 Findings

#### S1 — `emitEvent` silent drop is logged but not signaled to the caller

| Field | Value |
|---|---|
| **Severity** | High |
| **Walkthrough impact** | High |
| **Location** | `apps/server/src/services/WalkthroughJobs.ts:1416–1448` |
| **Failure mode** | MCP tool handler commits to DB. Before `emitEvent` runs, the job has already left the registry (superseded by a newer head SHA, or errored and cleaned). Drop is logged at `debug` level and silently returns. The MCP tool returns success to the agent; no subscriber sees the event; no reconciliation is triggered because the SSE stream may still be alive on the *new* job. |
| **Why it survives "commit-first, broadcast-second"** | Invariant #8 explicitly accepts dropped broadcasts as long as DB is correct. The remaining gap is observability: the orchestrator cannot today distinguish "broadcast skipped — fine, client will reconcile" from "broadcast skipped — but client thinks it is still streaming and will never reconcile." |
| **Remediation** | Make `emitEvent` return a typed result (`Delivered { seq }` / `SkippedNoJob`). MCP tool handler logs the skip with `walkthroughId`/`headSha` context. Long-term: consider rejecting the tool call with a structured error so the agent knows its write is orphaned. |

#### S2 — `fanOut` has no per-subscriber error budget

| Field | Value |
|---|---|
| **Severity** | High |
| **Walkthrough impact** | Medium |
| **Location** | `apps/server/src/services/WalkthroughJobs.ts:378–417` |
| **Failure mode** | A subscriber callback that throws on a specific event type (parser bug, malformed payload reaching the reducer) is caught and logged, but the same subscriber stays registered and will throw again on the next matching event. Concurrent subscribers experience consistent log spam and potentially head-of-line latency on the loop. |
| **Remediation** | Track a per-subscriber `consecutiveFailures` counter inside `ActiveJob.subscribers`. After N failures (3 is a sensible default), remove the subscriber and surface a single structured error log. Any healthy reconnect re-subscribes cleanly. |

#### S3 — `SESSION_TOKEN_TTL_MS` is a hardcoded 1h absolute TTL

| Field | Value |
|---|---|
| **Severity** | Medium |
| **Walkthrough impact** | Low (today) |
| **Location** | `apps/server/src/services/WalkthroughJobs.ts:81` |
| **Failure mode** | The HTTP MCP route (opencode path only) authenticates tool calls with an opaque session token. Token expiry is 1h wall-clock from issuance. A walkthrough that resumes through auto-continuations past 1h would 401 mid-stream. Not observed in practice because `CLI_WALKTHROUGH_TIMEOUT_MS = 10min` and `MAX_AUTO_CONTINUATIONS = 2`, but the coupling is implicit. |
| **Remediation** | Either tie TTL to `CLI_WALKTHROUGH_TIMEOUT_MS × (1 + MAX_AUTO_CONTINUATIONS)` with a small safety margin, or rotate the token on each auto-continuation. The first option is mechanical, the second is robust to changes in the timeout constants. |

#### S4 — SSE parser silently skips malformed JSON frames

| Field | Value |
|---|---|
| **Severity** | Medium |
| **Walkthrough impact** | Medium |
| **Location** | `apps/web/src/lib/utils/sse-parser.ts:63–68` |
| **Failure mode** | A corrupt `data:` line is `try/catch`-dropped with no callback, log, or counter. The client never knows it missed an event. A single bad block silently disappears from the UI. |
| **Remediation** | Add an optional `onParseError(line, error)` callback to `parseSSEBuffer<T>`. The walkthrough SSE caller wires it to a `console.warn` at minimum; eventually a stream-level metric. |

#### S5 — Exploration-stall timer fires off "absence of content," not an explicit phase signal

| Field | Value |
|---|---|
| **Severity** | Medium |
| **Walkthrough impact** | Medium |
| **Location** | `apps/web/src/lib/services/walkthrough-sse.ts:117–126` |
| **Failure mode** | The 3-minute exploration-stall guard fires when only `exploration` events have arrived. On a large PR where the agent explores for 2:59 then commits Phase A at 3:00, the stream dies right when output begins. The server-side guard (`stream-guard.ts`) does not have the same false-positive because it tracks `lastProgressTime` correctly, but the client-side guard is more conservative. |
| **Remediation** | Reset the client-side stall clock on an explicit `phase: exploring` heartbeat instead of inferring it from "no other event type." Cleaner contract; matches the server-side semantics. |

#### S6 — Reconciliation poll has no in-flight dedup per `prId`

| Field | Value |
|---|---|
| **Severity** | Medium |
| **Walkthrough impact** | Medium |
| **Location** | `apps/web/src/lib/stores/walkthrough-stream.svelte.ts:216–252` |
| **Failure mode** | An unexpected stream end schedules a poll on `GET /reviews/:prId/walkthrough/cached` with exponential backoff (1s → 30s, up to 8 attempts). Each attempt is fired regardless of any in-flight request. On a flaky network at minute 9:59 of a 10-minute stream, this is a burst of cache reads at the worst possible moment. |
| **Remediation** | Track a per-`prId` `pendingHydration` promise. New calls await the existing one instead of starting a new fetch. |

#### S7 — Cached `complete` replay does not re-validate the gate

| Field | Value |
|---|---|
| **Severity** | Low |
| **Walkthrough impact** | Low |
| **Location** | `apps/server/src/routes/reviews/handlers/walkthrough-stream.ts:285–325` |
| **Failure mode** | If the DB ever held a `status='complete'` row that failed invariant #12 (`lastCompletedPhase='D'` AND 9 ratings AND non-empty summary/sentiment AND ≥1 diff step), the cached replay would stream an incomplete walkthrough with `done`. Schema + `complete_walkthrough` gate make this unreachable today, but a tripwire on the replay path is cheap defense in depth. |
| **Remediation** | Before emitting the synthesized `done`, assert the four invariant-#12 conditions; emit `error` with a diagnostic code if any fail. Cost is a single helper call. |

#### S8 — No backpressure on slow clients

| Field | Value |
|---|---|
| **Severity** | Low |
| **Walkthrough impact** | Low |
| **Location** | `apps/server/src/routes/reviews/sse.ts:86–107` |
| **Failure mode** | `controller.enqueue()` throws when the stream's internal buffer fills (slow client, network lag). The write helper catches the throw and marks the subscriber cancelled; no retry, no flow control. The job continues, the client reconnects and reconciles — but the failure mode is invisible. |
| **Remediation** | Optionally track `controller.desiredSize`; surface a single warning log per subscriber when enqueue throws (rather than the silent `false` return). Real backpressure is out of scope for a single-user app. |

#### S9 — Replay-window dedup is per-handler, not per-job

| Field | Value |
|---|---|
| **Severity** | Low |
| **Walkthrough impact** | Low |
| **Location** | `apps/server/src/routes/reviews/handlers/walkthrough-stream.ts:132–228` |
| **Failure mode** | Dedup state (`seenBlocks`, `seenSummary`, …) lives in the request handler's closure. A tool retry that re-emits the same event would reach a fresh subscriber twice. The client reducer dedups by id, so user-visible damage is limited. |
| **Remediation** | Move dedup keys onto `ActiveJob.seen` so any subscriber inherits the same view. Low priority — current behavior is correct, just structurally fragile. |

#### S10 — Prerender failures fall back silently

| Field | Value |
|---|---|
| **Severity** | Low |
| **Walkthrough impact** | Low |
| **Location** | `apps/server/src/routes/reviews/handlers/walkthrough-stream.ts:243–255` |
| **Failure mode** | `prerenderBlock()` throws → block is emitted without `prerenderedHtml` → client falls back to worker-based tokenization. No telemetry flag indicates this happened, so we cannot answer "is the SSR cache earning its keep?" |
| **Remediation** | Add `prerenderedFailed?: true` (or a counter on the job) so the cache miss is observable. Pure observability — no correctness change. |

---

## 2. Broadcaster (global SSE bus)

### 2.1 Architecture

The long-lived global SSE stream (`GET /api/events`) carries cross-PR events and acts as the chat-edit broadcast bus per invariant #7. Implementation is a single `Ref<Set<Registration>>` of account-scoped writers with best-effort, fire-and-forget broadcast.

| Layer | File |
|---|---|
| Envelope union | `packages/shared/src/events.ts` (`ServerEventMessage`) |
| Bus | `apps/server/src/services/Broadcaster.ts` |
| Route | `apps/server/src/routes/events.ts` |
| Client | `apps/web/src/lib/stores/events.svelte.ts` |

Per the explicit broadcast contract (`Broadcaster.ts` doctrine + the reconnect note in `events.ts`): *"The server does NOT replay missed events on reconnect — the client reconciles via REST snapshots."* Commit-first, broadcast-second (invariant #8): callers must commit to SQLite before broadcasting; a lost broadcast is recoverable from the DB.

### 2.2 Event catalog (walkthrough-relevant)

All walkthrough lifecycle rides the single `walkthrough:event` envelope; the inner `data.event` (a `WalkthroughStreamEvent`) carries the variant below.

| Inner event type | Direction | Payload contract | Notes |
|---|---|---|---|
| `lifecycle:complete` | server→client | signal | Emitted at end of generation pipeline (Phase D validated). Client flips the entry to complete and reconciles from cache. |
| `lifecycle:error` | server→client | signal | Generation failed terminally. |
| `lifecycle:edited` | server→client | delta — the mutating content event follows with a later `seq` | Chat-edit carve-out (invariant #7). Reuses the same reducer / per-walkthrough `seq` cursor. |
| `prs:updated` (top-level envelope) | server→client | full-state | PR list snapshot. |
| `prs:sync-summary` (top-level envelope) | server→client | delta | Highlights changes since last sync. |

The non-walkthrough envelopes are catalogued in [§4 Tangential findings](#4-tangential-findings) where the audit notes affect them.

### 2.3 Already correct

| Invariant | Evidence |
|---|---|
| #7 chat-edit carve-out | `lifecycle:edited` emitted from chat-edit MCP handlers only; the generation path never produces it. |
| #8 commit-first | `lifecycle:complete` site at `WalkthroughJobs.ts` awaits `setStatus(..., 'complete', ...)` *then* broadcasts, with a 5s timeout-and-swallow on the broadcast. |
| Reconnect reconciliation | Client `open` handler (on reconnect, `openCount > 1`) calls `reconcileOnReconnect()` → `fetchRepos/fetchPrs/fetchPinnedPrs` + `hydrateFromCache(selectedPrId)` + `loadSession`. Invariant #8 honored. |
| Strong typing | `ServerEventMessage` union shared end-to-end; client `dispatch(msg: ServerEventMessage)` cases the union with an exhaustive `never` check and no `any` widening. |
| Auth | Bearer-token-via-`?token=` query param validated against `better-auth` (`Identity`) in the SSE route; missing/invalid token → 401. An unresolvable account opens an observer-only (`"unresolved"`) connection that receives no scoped broadcasts. |

### 2.4 Findings

#### W1 — No heartbeat / dead-connection detection — **RESOLVED**

| Field | Value |
|---|---|
| **Severity** | Medium |
| **Walkthrough impact** | High |
| **Location** | `apps/server/src/routes/events.ts`, `apps/web/src/lib/stores/events.svelte.ts` |
| **Failure mode** | Proxies, OS sleep, NAT timeouts, captive-portal limbo can sever a TCP connection without delivering a close frame to either end. The client sat on a dead stream missing every `lifecycle:complete`, `lifecycle:edited`, and `lifecycle:error` until the user took an action that surfaced the broken state. This was the most likely root cause of "the UI didn't update" bug reports in a long-running session. |
| **Resolution** | The SSE route emits a named `heartbeat` event every 15s (`HEARTBEAT_INTERVAL_MS`). The client runs a watchdog (`startWatchdog`) that checks every 30s (`KEEPALIVE_CHECK_INTERVAL_MS`) and force-closes + reconnects after >60s silence (`DEAD_CONNECTION_THRESHOLD_MS`). |

#### W2 — `pendingThreadSync` single-slot overwrite — **OBSOLETE**

| Field | Value |
|---|---|
| **Severity** | Low |
| **Walkthrough impact** | Low |
| **Location** | (was) `ws.svelte.ts:229–237` |
| **Status** | No longer applies. The per-PR pending-sync slot is gone: `requestThreadSync` (`sync.svelte.ts`) fires the `POST /sync-threads` REST call directly, and `reconcileOnReconnect` invokes it per selected PR. In-flight state is tracked as a `Set<string>` (`threadsSyncingByPr`), so there is no single slot to overwrite. |

#### W3 — Malformed message silently swallowed — **RESOLVED**

| Field | Value |
|---|---|
| **Severity** | Low |
| **Walkthrough impact** | Low |
| **Location** | `apps/web/src/lib/stores/events.svelte.ts` (`message` handler) |
| **Failure mode** | The `JSON.parse → dispatch` chain previously wrapped in `try { … } catch { }` with no log, counter, or hook, so a serializer bug or schema drift produced no diagnostic trail. |
| **Resolution** | The handler now `console.warn`s `"[events] malformed message:"` on parse failure. A counter for the observability layer is still a future nicety, but the silent-swallow is gone. |

#### W4 — Event listeners not explicitly removed on disconnect

| Field | Value |
|---|---|
| **Severity** | Low |
| **Walkthrough impact** | Low |
| **Location** | `apps/web/src/lib/stores/events.svelte.ts` (`connect` / `disconnect`) |
| **Failure mode** | `addEventListener` on the `EventSource` with no matching `removeEventListener`; `disconnect()` relies on `source.close()` + nulling the ref so GC reclaims the listeners. Works, but brittle: any code retaining a reference to the old source retains its listeners too. |
| **Remediation** | Capture listener references in closure-scoped variables; have `disconnect()` call `removeEventListener` for each. Cosmetic but cheap. |

#### W5 — `ServerEventMessage` union members lack signal/state/delta JSDoc

| Field | Value |
|---|---|
| **Severity** | Low |
| **Walkthrough impact** | Low |
| **Location** | `packages/shared/src/events.ts` |
| **Failure mode** | Conventions §3 (SSE event envelopes) requires each event's payload contract (signal / full-state / delta) to be documented at the type definition. Today only `WalkthroughEventEnvelope` carries a substantial docstring. Future readers cannot tell from the type whether a `prs:updated` is a delta or a snapshot. |
| **Remediation** | Add a JSDoc comment per union member with one of the three labels and a one-line rationale. |

### 2.5 Deliberate non-findings

These were flagged by the sub-audits but are not actionable in the current product shape. Recorded so future readers do not re-raise them.

#### W6 — Per-user authorization scoping on broadcasts

| Field | Value |
|---|---|
| **Sub-audit claim** | "Critical: broadcast-to-all without filtering by PR ownership / user permissions." |
| **Why not actionable** | Revv is a single-user Tauri desktop application with one OAuth principal per running server. There is no "client A vs client B" today. The "missing scoping" finding only becomes real if Revv ever ships a multi-tenant deployment mode. |
| **Trigger to revisit** | Any product change that introduces multiple authenticated users against a shared server process. |

#### W7 — Reconnect-backoff jitter

| Field | Value |
|---|---|
| **Sub-audit claim** | "Thundering herd risk on server restart with deterministic 2^n backoff." |
| **Why not actionable** | One client per server. No fleet. Jitter solves a problem that does not exist in this shape. |
| **Trigger to revisit** | Same as W6 — any multi-instance / multi-client deployment story. |

---

## 3. Provider façade

### 3.1 Architecture

`AiService.streamWalkthrough` (`apps/server/src/services/Ai.ts:238–306`) is the entry point. It resolves the configured agent via `resolveAgent(settings)` and dispatches to one of two providers:

| Provider | Transport | File |
|---|---|---|
| Claude Agent SDK | in-process MCP | `apps/server/src/ai/providers/mcp-walkthrough.ts` |
| opencode | HTTP MCP via `opencode serve` daemon | `apps/server/src/ai/providers/mcp-walkthrough-opencode.ts` |

Both return `AsyncGenerator<WalkthroughStreamEvent>`. Both go through `guardWalkthroughStream` (`apps/server/src/ai/providers/stream-guard.ts`) which adds inactivity / first-event / exploration-stall timeouts and terminal-event synthesis. Both call the **same** shared MCP tool handlers from `apps/server/src/ai/providers/walkthrough-tools/` (`TOOL_SPECS` at `walkthrough-tools/index.ts`).

The opencode daemon lifecycle is owned by `OpencodeSupervisor` (`apps/server/src/services/OpencodeSupervisor.ts`): lazy-start, idle 30s cooldown stop, agent-change stop, crash-loop cap (3 in 60s).

### 3.2 Audit-agent correction — `synthesizePhases` is *not* a divergence

The exploration sub-audit reported that the Claude path passes `synthesizePhases: true` while the opencode path passes `false`, calling this a parity violation. **This is wrong.** Both call sites pass `false` today:

- `apps/server/src/services/Ai.ts:296` — opencode: `synthesizePhases: false`.
- `apps/server/src/services/Ai.ts:305` — Claude: `synthesizePhases: false`.

The guard's role is now timeouts and terminal-event synthesis; neither provider relies on phase synthesis. Recorded here so the wrong claim does not propagate.

### 3.3 Already correct

| Invariant | Evidence |
|---|---|
| #2 / #13 — Shared tool handlers | Both paths import `TOOL_SPECS` from `walkthrough-tools/index.ts` and call the same handlers. |
| #4 / #5 — Phase preconditions | Enforced inside the shared handlers (`set_overview` requires `phase = 'none'`, `set_sentiment` requires `'B'`, `rate_axis` requires `'C'`/`'D'`, `complete_walkthrough` requires `'D'`). Same code path for both providers. |
| #11 — Status transitions orchestrator-only | Both providers emit content events; status writes happen only in `WalkthroughJobs`. |
| #12 — Validation gate | `completeWalkthroughHandler` asserts the four invariant-#12 conditions before any status transition is requested. |
| #14 — Daemon lifecycle | `OpencodeSupervisor` lazy-starts on first `jobStarted()`, stops 30s after refcount → 0, kills on agent change (detected on next `jobStarted`), persists no credentials. |
| Per-job worktree | Worktree finalizer registered on the job's scope; cleanup composes correctly with both providers. |

### 3.4 Findings

#### P1 — Event-emission timing asymmetry between Claude and opencode

| Field | Value |
|---|---|
| **Severity** | High |
| **Walkthrough impact** | High |
| **Location** | `apps/server/src/ai/providers/mcp-walkthrough.ts` (Claude SDK queue) vs `apps/server/src/routes/mcp/walkthrough.ts` + `apps/server/src/services/WalkthroughJobs.ts:1416–1448` (opencode HTTP path). Discussed in the comment block at `apps/server/src/ai/providers/mcp-walkthrough-opencode.ts:71–80`. |
| **Failure mode** | **Claude path**: a content tool handler (e.g. `set_overview`) commits to DB and pushes the event into the provider generator's in-process queue *inline*. The generator yields it interleaved with `exploration`/`phase` events the generator is also producing. **Opencode path**: the same handler commits and emits via `WalkthroughJobs.emitEvent()` from the HTTP route. The provider generator separately yields `exploration` / `phase` events on its own SSE subscription to `opencode serve`. The two streams converge at the SSE handler, but **ordering relative to non-content events is path-dependent**. A `block` may arrive before its `phase: writing` on one path and after on the other. This is a direct invariant #13 violation in spirit, even though both paths produce the same set of events. |
| **Remediation** | Unify by routing Claude's content events through the same out-of-band emit path as opencode. The Claude in-process handler already has access to `WalkthroughJobs.emitEvent`; the generator's internal queue is what produces the asymmetry. Concretely: change Claude tool handlers to call `emitEvent` and stop pushing into the generator queue; the generator becomes a thin `exploration`/`phase`/`done` channel just like opencode. |

#### P2 — `ALLOWED_TOOLS` hand-maintained and silent-on-drift

| Field | Value |
|---|---|
| **Severity** | High |
| **Walkthrough impact** | High |
| **Location** | `apps/server/src/ai/providers/mcp-walkthrough.ts:64–81` vs `apps/server/src/ai/providers/walkthrough-tools/index.ts` (`TOOL_SPECS`). |
| **Failure mode** | The Claude SDK options need an explicit `allowedTools` list. Today it is a hardcoded literal array of 13 entries (built-ins + MCP-prefixed names). If a new spec is added to `TOOL_SPECS` without also adding its prefixed name here, the SDK refuses to surface the tool to the model — the agent stalls (e.g. cannot leave Phase A because `set_overview` is invisible) and **there is no error in any log**. The comment at line 60–63 already acknowledges the hazard. |
| **Remediation** | Derive the MCP-side entries from `TOOL_SPECS.map(s => \`${MCP_TOOL_PREFIX}${s.name}\`)` at module init. Keep the built-in tools (`Read`, `Grep`, `Glob`) as a static prefix. Add a `satisfies` clause asserting the count matches expectations as a tripwire. |

#### P3 — First-event timeout asymmetry (90s vs 150s) is undocumented in CLAUDE.md

| Field | Value |
|---|---|
| **Severity** | Medium |
| **Walkthrough impact** | Medium |
| **Location** | `apps/server/src/constants.ts:24,27`; consumed at `apps/server/src/services/Ai.ts:297`. |
| **Failure mode** | Claude gets 90s to produce its first event; opencode gets 150s. The 60s gap is justified by daemon cold-start + MCP registration + model TTFT (per the comment at constants.ts:26). Two consequences: (1) the same PR against the same model can succeed on one provider and time out on the other; (2) future agents reading `CLAUDE.md` will see invariant #13 ("byte-for-byte parity") with no carve-out documenting why this difference is allowed, and may "fix" it accidentally. |
| **Remediation** | Add a one-paragraph carve-out to `CLAUDE.md` under invariant #13 explaining that first-event timing is allowed to differ for documented daemon-cold-start reasons. Alternatively, shrink the gap by warming the daemon in `ensureRunning` (out of scope for the audit step). |

#### P4 — Opencode supervisor reacts to agent-change only on next `jobStarted`

| Field | Value |
|---|---|
| **Severity** | Medium |
| **Walkthrough impact** | Medium |
| **Location** | `apps/server/src/services/OpencodeSupervisor.ts:711–715` |
| **Failure mode** | Invariant #14 reads: *"they are stopped when idle or when the selected agent changes."* The current implementation stops the daemon on agent change *only when the next `jobStarted()` runs*. Between the settings flip and the next job, the daemon (and its bound port + spawned process) keeps running. The user can experience a delay before the agent change "takes." |
| **Remediation** | Wire `OpencodeSupervisor` to a `SettingsService` change stream (Effect pubsub or `Ref.subscribe`). On agent-change, call `stopNow()` immediately. Idle cooldown remains as-is. |

#### P5 — `resolveAgent` silently downgrades unknown values

| Field | Value |
|---|---|
| **Severity** | Low |
| **Walkthrough impact** | Low |
| **Location** | `apps/server/src/services/Ai.ts:87–91` |
| **Failure mode** | `resolveAgent` returns `"opencode"` for any value of `settings.aiAgent` that is not exactly `"opencode"` or `"claude"`. A typo, a settings migration bug, or a future-removed agent name produces zero diagnostics — the user sees opencode behavior with no indication their preference was ignored. |
| **Remediation** | Either narrow `settings.aiAgent` to a typed union at the settings boundary and treat the wrong-value branch as a `ValidationError`, or surface the downgrade via a single warn-level log on first call. The typed-union approach is preferred. |

#### P6 — Opencode tool-name dispatch tolerates both prefixed and bare names

| Field | Value |
|---|---|
| **Severity** | Low |
| **Walkthrough impact** | Low |
| **Location** | `apps/server/src/ai/providers/mcp-walkthrough-opencode.ts` (`matchSuffix` helper). |
| **Failure mode** | The opencode SSE stream sometimes reports tool calls with the MCP prefix (`mcp__revv-walkthrough__set_overview`) and sometimes bare (`set_overview`). The dispatcher accepts both via a suffix match. Claude always carries the prefix. If opencode tightens its naming convention (or another tool happens to have a colliding suffix), the dispatcher silently picks the wrong tool. |
| **Remediation** | Constrain `matchSuffix` to a fixed allowlist (the `TOOL_SPECS` names) plus prefix. Add a focused test that both providers see the same set of tool names. |

#### P7 — Session token TTL (see S3)

Same finding as S3, captured here because it also constrains the façade — opencode's HTTP MCP transport is the consumer of the token. A single fix covers both surfaces.

#### P8 — `OpencodeSupervisor` has no reactive `Settings` listener

Captured alongside P4 because P4's remediation requires this. Carrying the id separately so the backlog can reference the prerequisite if P4 is sequenced.

---

## 4. Tangential findings

These came out of the broad-scope audit but do not touch the walkthrough generation hot path. Listed for completeness so the arc has an honest picture of the surface area.

| Id | Layer | Finding | Impact |
|---|---|---|---|
| T1 | SSE | `thread:*` events broadcast to every connected client in the account even though they are PR-scoped. Wastes a bit of bandwidth + frontend processing in a single-user app; would be a real problem in any multi-tenant future. | Low. |
| T2 | SSE | No sequence numbers on the non-walkthrough envelopes (`prs:updated`, `thread:*`, …). Subscribers cannot detect "missed N messages" — they can only reconcile DB state. (Walkthrough envelopes do carry a per-walkthrough `seq`.) Invariant #8 says this is fine, but it limits diagnostic tooling. | Low. |
| T3 | SSE | Phase-message strings (`"Reading files and understanding changes…"`) are shipped from the server inside the event. UI does not allow customization. Likely fine, but worth noting as a coupling. | Low. |
| T4 | Façade | Crash-loop unhealthy state for opencode persists across server restarts (loaded from `kvCache`). Recovery requires either a manual reset or waiting for the rolling window to expire. UX friction, not correctness. | Low. |

---

## 5. Cross-references

- [`backlog.md`](./backlog.md) — punch list with `Now / Next / Later / Not actionable / Done` sections.
- [`../conventions.md`](../conventions.md) — code conventions (Effect, SSE event envelopes, stores, motion).
- [`../conventions-backlog.md`](../conventions-backlog.md) — convention violations with severity / effort / blast.
- [`../../CLAUDE.md`](../../CLAUDE.md) — load-bearing project guide. Invariants referenced throughout this audit live in *Agent Subsystem Invariants*.
- [PRD-03 (AI Guided Walkthrough)](../prds/03-ai-walkthrough.md) — see CLAUDE.md for current agent subsystem invariants.
