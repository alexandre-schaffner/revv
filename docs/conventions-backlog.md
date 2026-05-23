# Conventions Backlog

Every known violation of [`conventions.md`](./conventions.md), with a back-pointer to the rule
it breaks and a rough sizing for the fix. Worked top-to-bottom in the order suggested by the
default sort.

## Summary

| Domain | Open | Severity mix |
|---|---|---|
| Server (Effect) | 0 | — |
| Web stores | 1 | low |
| UI / motion | 14 | all fixed |
| **Total** | **1** | |

---

## Open

<a id="s-005"></a>
### S-005 — `deleteRepo` uses list-snapshot rollback instead of entity-scoped

**Rule violated:** [§4.6 — Client-initiated mutations are optimistic with entity-scoped rollback](./conventions.md#stores-optimistic).

**Where:** `apps/web/src/lib/stores/prs.svelte.ts:455-487` (`deleteRepo`), with helpers
`snapshotRepoState` (`:188-196`) and `restoreRepoState` (`:198-205`).

**Why it's a violation.** On error, `restoreRepoState` reassigns `repositories`,
`pullRequests`, `archivedPrs`, `taggedPrsByRepo`, and `pinnedPrIds` to the pre-mutation
snapshot. Any `prs:updated` / `repos:updated` / `pr:archived` broadcast that landed during
the in-flight POST is silently dropped — including entirely unrelated entities the server
added or removed for reasons that have nothing to do with this delete.

**Fix shape.** Capture the *removed* state, not the *prior* state: which repo row was
removed, which open PR ids and archived PR ids were removed, which pinned ids were removed.
On rollback, re-insert each. Concurrent broadcasts that touched other entities survive
untouched.

**Severity:** Low — the failure mode is "concurrent unrelated broadcast lost during a
rollback that itself is rare." Not actively biting in production. Tracked because
`deleteRepo` is the canonical anti-pattern §4.6 was added to prevent and leaving it as-is
implicitly endorses the shape.

**Sizing:** ~30 lines. One PR. Worth pairing with any other touch to the repo-delete flow.

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
- M-015 — dialog-overlay: `duration-100` → `duration-instant`
- M-016 — switch: `duration-200` → `duration-quick`; stripped `var()` fallback literals
- M-017 — RightPanel: `220ms` literals (×2) → `var(--duration-smooth)`; `cubic-bezier(...)` → `var(--ease-standard)`
- M-018 — ChatTimeline: `220ms cubic-bezier(...)` → `var(--duration-smooth) var(--ease-standard)`
- M-019 — ContextTrigger: `240ms` → `var(--duration-smooth)`; stripped `var()` fallback
- M-020 — RatingTestRow: `180ms` (×2) → `var(--duration-quick)`; `220ms ease-out` → `var(--duration-smooth) var(--ease-out-expo)`; `1.2s ease-in-out` → `var(--duration-pulse) var(--ease-soft)`
- M-021 — RatingGridCell: `180ms` → `var(--duration-quick)`; `1.4s ease-in-out` → `var(--duration-pulse) var(--ease-soft)`
- M-022 — SpecRow: `180ms` → `var(--duration-quick)`; `1.2s ease-in-out` → `var(--duration-pulse) var(--ease-soft)`
- M-023 — IssueTestRow: `0.5s` → `var(--duration-ceremonial-medium)`
- M-024 — CommentTestRow: `0.5s` → `var(--duration-ceremonial-medium)`
- M-025 — FloatingTabs: `1.4s ease-in-out` → `var(--duration-pulse) var(--ease-soft)`
- M-026 — app.css: `ease-out` → `var(--ease-out-expo)`; `1.5s ease-in-out` → `var(--duration-pulse) var(--ease-soft)`; `300ms cubic-bezier(...)` → `var(--duration-ceremonial-quick) var(--ease-soft)`
- M-027 — dotmatrix-loader: `cubic-bezier(0.42, 0, 0.58, 1)` → `var(--ease-soft)`; `ease-in-out` (×3) → `var(--ease-soft)`; `180ms cubic-bezier(...)` → `var(--duration-quick) var(--ease-soft)`
- M-028 — Added `--duration-pulse: 1400ms` to app.css `@theme` block
