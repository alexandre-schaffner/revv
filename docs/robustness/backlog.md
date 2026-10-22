# Robustness Backlog

Living punch list for the robustness and reliability arc on walkthrough generation. Findings are taken from [`audit.md`](./audit.md); rows reference the audit by id (`[Sn]` / `[Wn]` / `[Pn]` / `[Tn]`).

**Sort rule.** Walkthrough-generation impact first, severity second. Quick wins (XS / S effort) on high-impact items beat slow polish on low-impact items.

**Row shape.**

```
- [ ] **[Id]** one-line description (file:line) — one-line remediation sketch.
```

Move items to `## Done` (or strike them with `~~…~~`) as their PR lands. Keep the audit doc in sync if a finding turns out to be wrong; do not rewrite history here.

---

## Done

All items from the robustness arc have landed.

- [x] **[P1]** Unify event-emission timing between Claude and opencode (`mcp-walkthrough.ts` + `WalkthroughJobs.ts:1416`) — route Claude content events through `WalkthroughJobs.emitEvent` so both providers converge at a single emit site.
- [x] **[P2]** Derive `ALLOWED_TOOLS` from `TOOL_SPECS` (`mcp-walkthrough.ts:64–81`) — replace hardcoded array with `[…builtins, ...TOOL_SPECS.map(s => \`${MCP_TOOL_PREFIX}${s.name}\`)]` and add runtime count tripwire.
- [x] **[S1]** Surface `emitEvent` silent drops (`WalkthroughJobs.ts:1416–1448`) — return typed `Delivered | SkippedNoJob` result; log skip with `walkthroughId`/`type` context.
- [x] **[S2]** Add per-subscriber error budget to `fanOut` (`WalkthroughJobs.ts:378–417`) — track `consecutiveFailures` on each subscriber handle; drop after 3 consecutive throws with a single structured log.
- [x] **[W1]** SSE keepalive + dead-connection detection (`routes/events.ts` + `stores/events.svelte.ts`) — server emits a named `heartbeat` event every 15s; client watchdog treats >60s silence as dead and force-reconnects.
- [x] **[S5]** Reset client-side exploration-stall clock on explicit `phase: exploring` (`walkthrough-sse.ts:117–126`) — replace "no other event type for 3min" inference with an explicit heartbeat, matching server-side `stream-guard.ts` semantics.
- [x] **[P4]** Reactive daemon stop + eager start on agent change (`OpencodeSupervisor.ts` + `Settings.ts`) — `SettingsService` exposes `settingsChanges()` stream; supervisor forks a fiber that eagerly starts when `aiAgent` flips to opencode and immediately stops when it flips away.
- [x] **[S6]** Dedup in-flight reconciliation polls per `prId` (`walkthrough-stream.svelte.ts:216–252`) — track `pendingHydration: Map<string, Promise<…>>`; concurrent callers await the existing promise.
- [x] **[S4]** + **[W3]** Parse-error observability (`sse-parser.ts` + `stores/events.svelte.ts`) — add optional `onParseError` callback to `parseSSEBuffer<T>`; `console.warn` malformed SSE messages.
- [x] **[S7]** Re-validate invariant #12 on the cached-replay path before emitting `done` (`walkthrough-stream.ts:285–325`) — defense-in-depth tripwire; emits `error` + `done` if validation fails.
- [x] **[S8]** Surface SSE enqueue throw as a single log per subscriber (`sse.ts:86–107`) — already implemented via `logError` on first throw; `cancelled` flag ensures single log.
- [x] **[W2]** Per-PR thread-sync dedup (`stores/sync.svelte.ts`) — in-flight state tracked as `Set<string>` (`threadsSyncingByPr`); the old single-slot `pendingThreadSync` overwrite is gone.
- [x] **[W4]** Clean teardown on SSE disconnect (`stores/events.svelte.ts`) — `disconnect()` clears the watchdog timer, closes the `EventSource`, and nulls the ref so stale handlers can't survive a reconnect.
- [x] **[W5]** Per-member JSDoc on `ServerEventMessage` documenting signal / full-state / delta semantics (`packages/shared/src/events.ts`).
- [x] **[S10]** Add `prerenderFailures` counter on `ActiveJob` (`WalkthroughJobs.ts:106`) — incremented in `walkthrough-stream.ts` when `prerenderBlock` throws; logged on `done` event in `fanOut`.
- [x] **[P5]** Narrow `settings.aiAgent` to typed union — validate in `Settings.ts` normalize instead of casting; `resolveAgent` throws `ValidationError` on unknown values rather than silently downgrading to `"opencode"`.
- [x] **[P6]** Constrain opencode `matchSuffix` to `TOOL_SPECS` allowlist (`mcp-walkthrough-opencode.ts:367`) — rejects unknown tool names with a debug log; prevents rogue / hallucinated tool names from driving bogus phase transitions.
- [x] **[T4]** Auto-reset opencode crash-loop unhealthy flag after extended idle (`OpencodeSupervisor.ts:588`) — `UNHEALTHY_AUTO_RESET_MS = 5min`; `ensureRunning()` clears `unhealthy` + crash log after 5 minutes of idle so the next job can retry.
- [x] **[S3]** + **[P7]** Tie `SESSION_TOKEN_TTL_MS` to timeout budget (`WalkthroughJobs.ts:81`) — derived as `CLI_WALKTHROUGH_TIMEOUT_MS × (1 + MAX_AUTO_CONTINUATIONS) + 5min margin`; no longer a magic 1-hour constant.

## Next

(Empty — all items from this arc have landed. See `## Done` below.)

## Later / opportunistic

Worth doing when adjacent code is being touched.

- ~~**[S9]** Move replay-window dedup keys onto `ActiveJob` (`walkthrough-stream.ts:132–228`)~~ — **Not actionable as described.** Per-connection dedup is required: a global `ActiveJob.seen` would suppress snapshot replay for late-connecting subscribers (they'd miss events emitted before connect but present in the DB snapshot). Current behavior is correct; audit rates this Low / Low.
- **[S11]** Add parity test for tool-name set between `TOOL_SPECS` and opencode `matchSuffix` allowlist — ensure the two lists never drift.

## Not actionable today

Recorded so they are not re-raised in a future audit pass.

- **[W6]** Per-user authorization scoping on SSE broadcasts — broadcasts are already account-scoped (`broadcastToAccount`), but single-user desktop means no second principal exists within an account. Revisit if Revv ever ships multi-tenant.
- **[W7]** Reconnect-backoff jitter — single client per server, no thundering-herd risk. Same revisit trigger as W6.
- **[T1]** PR-scoped routing for `thread:*` broadcasts — same single-user reasoning.
- **[T2]** Sequence numbers on the non-walkthrough envelopes — invariant #8 explicitly accepts dropped messages with DB reconciliation; sequence numbers would only add diagnostic value, not correctness. (Walkthrough envelopes already carry a `seq`.)
- **[T3]** Server-controlled phase-message strings — UI coupling, not a robustness issue.
