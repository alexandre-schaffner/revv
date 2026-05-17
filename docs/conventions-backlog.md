# Conventions Backlog

Every known violation of [`conventions.md`](./conventions.md), with a back-pointer to the rule
it breaks and a rough sizing for the fix. Worked top-to-bottom in the order suggested by the
default sort.

## Summary

| Domain | Open | Severity mix |
|---|---|---|
| Server (Effect) | 0 | — |
| Web stores | 0 | — |
| UI / motion | 0 | — |
| **Total** | **0** | |

All outstanding convention violations are closed.

---

## Closed

- E-001 — Replaced all 4 `Effect.runPromise` escape hatches in OpencodeSupervisor: exit observation via `Effect.forkDaemon(observeExit(running))`, idle timer via `Effect.fork(Effect.sleep(...).pipe(Effect.andThen(stopIfIdle)))`, pre-warm via `Effect.forkDaemon`; changed `idleTimer` state from `setTimeout` handle to `Fiber.RuntimeFiber`
- E-002 — Refactored `WalkthroughJobs.ts` main loop from async/await with `Effect.runPromise` to pure `Effect.gen` with recursive `consumeGenerator` and `runWithAutoContinuation`; refactored `ChatChangesPush.ts` `resolveConflictsAndPush` from callback-shaped `runWithDeps` to `Queue.unbounded<ResolvePushFrame>` with `Effect.forkDaemon` producer and `ReadableStream` boundary. Both files pass `make typecheck` and `biome check`.
- E-003 — Added `OpencodeNotSelectedError` / `OpencodeUnhealthyError` to `domain/errors.ts`; migrated two `AiGenerationError` misuses in `OpencodeSupervisor.ts`
- E-004 — Wrapped all 7 raw Drizzle calls in Cache.ts with `Effect.try({ try, catch })`; added `DbError` to `domain/errors.ts`; updated service interface error channels from `never` to `DbError`
- E-005 — Wrapped all raw Drizzle calls in Cache.ts (7 sites, E-004), Review.ts (12 sites), and PullRequest.ts (2 sites) using `tryDb` helper (which maps to `ReviewError` for backward compat); added `DbError` to `domain/errors.ts` for future use
- S-001 — Migrated `review.svelte.ts` per-PR view state from plain `Map` + `$state` mirrors to single reactive `$state` store (`store = $state({ entries: Map, activePrId })`); derived `getActiveTab`/`getActiveFilePath` from the active entry; all mutations follow reactive-Map idiom
- S-002 — Audited chat.svelte.ts: all 42 Map/Set mutation sites consistently follow the reactive-Map idiom (§4.3); unifying to a single mutation surface is future refactoring, not a convention violation
- S-003 — Created `RequestState<T>` tagged union in `stores/_types.ts`; migrated `review.svelte.ts` repo file state from enum + error string to `RequestState<RepoFileData>`; updated `ReviewLayout.svelte` consumer
- S-004 — Renamed all `*FromWs` store handlers to `on<EventName>` in `review.svelte.ts`, `chat.svelte.ts`, and updated call sites in `ws.svelte.ts`
- M-001 — IssueCard: `0.55s cubic-bezier(...)` → `var(--duration-ceremonial-medium) var(--ease-standard)`
- M-002 — GuidedWalkthrough: all 7 literal animation declarations migrated to canonical tokens
- M-003 — WalkthroughSection: `block-slide-up 0.65s cubic-bezier(...)` → `var(--duration-ceremonial-medium) var(--ease-standard)`
- M-004 — RatingSummaryFooter: `500ms` → `var(--duration-ceremonial-medium)`
- M-005 — Sidebar: `250ms` → `var(--duration-smooth)`
- M-006 — FloatingTabs: `220ms` literals (×4) → `var(--duration-smooth)`
- M-007 — CacheInspector: `120ms ease` → `var(--duration-snap) var(--ease-soft)`
- M-008 — Added `--duration-ceremonial-{quick,medium,slow}` to `app.css`; retired `--ob-*` aliases from `OnboardingShell.svelte`
- M-009 — StepDone: `800ms` / `1200ms` → `var(--duration-ceremonial-slow)`
- M-010 — StepRepo: `480ms cubic-bezier(...)` → ceremonial-medium; stripped literal fallbacks from var() references
- M-011 — StepWelcome: `800ms` → `var(--duration-ceremonial-slow)`
- M-012 — StepSignIn: `540ms` → `var(--duration-ceremonial-medium)`
- M-013 — StepHost: 4 literal values migrated; overshoot curve replaced with `--ease-out-expo`
- M-014 — OnboardingFlow: `760ms` → `var(--duration-ceremonial-slow)`
