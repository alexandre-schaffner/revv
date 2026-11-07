# Conventions Backlog

Every known violation of [`conventions.md`](./conventions.md), with a back-pointer to the rule
it breaks and a rough sizing for the fix. Worked top-to-bottom in the order suggested by the
default sort.

## Summary

| Domain | Open | Severity mix |
|---|---|---|
| Server (Effect) | 1 | medium |
| Server (layout) | 1 | low |
| Web stores | 0 | — |
| UI / motion | 1 | low |
| **Total** | **3** | |

---

## Open

<a id="e-006"></a>
### E-006 — DB services leak `R = DbService`, so every caller wraps them in `withDb`

**Rule violated:** [§2 — Effect services](./conventions.md#effect-services), in spirit: a
service captures its dependencies when its layer is built (as `GitHubEtagCache` and `PrContext`
do), so callers never provide them per call. Not yet written down as its own rule.

**Where:** `PullRequestService` (`services/PullRequest.ts`), `RepositoryService`
(`services/Repository.ts`), and outside the GitHub area `WalkthroughService`,
`ProjectRecapService`, `WalkthroughSnapshotImporter`: each is a `Layer.succeed` whose methods
declare `R = DbService`, so ~40 call sites across ~16 files bridge them with
`effects/with-db.ts` (`PollScheduler`, `PrMirror`, `PrContext`, `poll-*`, stacks, recaps,
walkthrough lifecycle). Their Drizzle calls are wrapped in `tryDb` and fail with `DbError`.

**Fix shape.** Make each a `Layer.effect` that captures `DbService`, drop `DbService` from the
method signatures, and delete `effects/with-db.ts` with its call sites. Mechanical, touches
every caller; scheduled as one change.

**Severity:** Medium (a convention callers must know; no runtime fault).

---

<a id="s-001"></a>
### S-001 — Feature files still flat beside (or instead of) a `services/<feature>/` folder

**Rule violated:** [§2.7 — A multi-file feature owns a folder](./conventions.md#services-layout).

**Where** (`apps/server/src/services/`):

- chat: `ChatSession.ts`, `ChatMcpTokens.ts`
- external integrations: `ExternalIntegrations.ts`
- jobs: `job-mutex.ts`, `job-subscribers.ts`, `session-token-store.ts`
- no folder yet: poll (`PollScheduler.ts`, `poll-{gate,maintenance,notifications,open-prs,state}.ts`)

**Fix shape.** Moves plus import rewrites, one feature per PR, with the feature roots in
`scripts/check-import-boundaries.ts` following. Mechanical, but it touches every importer, so
it lands when nothing else is in flight in that feature.

**Severity:** Low.

<a id="m-030"></a>
### M-030 — `weight="bold"` on an 18px dialog-title glyph

**Rule violated:** [§5.3 — Iconography](./conventions.md#motion-icon-only) (`bold` is for
glyphs at 15px or less, or an outline mark in a set of `fill` marks).

**Where:** `apps/web/src/lib/components/stack/StackMergeSheet.svelte` — the `GitMerge size={18}`
in the sheet's title.

**Fix shape.** `regular`, or a size the rule covers. A visible change; check it against the
other dialog titles first.

**Severity:** Low.

---

## Closed

- E-001 — Replaced all 4 `Effect.runPromise` escape hatches in OpencodeSupervisor (since deleted with the opencode daemon transport; agents run over ACP)
- E-002 — Refactored `WalkthroughJobs.ts` main loop from async/await with `Effect.runPromise` to pure `Effect.gen` with recursive `consumeGenerator` and `runWithAutoContinuation`; refactored `ChatChangesPush.ts` `resolveConflictsAndPush` from callback-shaped `runWithDeps` to `Queue.unbounded<ResolvePushFrame>` with `Effect.forkDaemon` producer and `ReadableStream` boundary. Both files pass `make typecheck` and `biome check`.
- E-003 — Added `OpencodeNotSelectedError` / `OpencodeUnhealthyError` for two `AiGenerationError` misuses in `OpencodeSupervisor.ts` (all three since deleted with the opencode daemon transport)
- E-004 — Wrapped all 7 raw Drizzle calls in Cache.ts with `Effect.try({ try, catch })`; added `DbError` to `domain/errors.ts`; updated service interface error channels from `never` to `DbError`
- E-005 — Wrapped all raw Drizzle calls in Cache.ts (7 sites, E-004), Review.ts (12 sites), and PullRequest.ts (2 sites) using the `tryDb` helper (failing with `DbError`); `Repository.ts` followed in round 2 (its `addRepo` no longer turns DB faults into `ValidationError`)
- S-001 — Migrated `review.svelte.ts` per-PR view state from plain `Map` + `$state` mirrors to single reactive `$state` store (`store = $state({ entries: Map, activePrId })`); derived `getActiveTab`/`getActiveFilePath` from the active entry; all mutations follow reactive-Map idiom
- S-002 — Audited chat.svelte.ts: all 42 Map/Set mutation sites consistently follow the reactive-Map idiom (§4.3); unifying to a single mutation surface is future refactoring, not a convention violation
- S-003 — Created `RequestState<T>` tagged union in `stores/_types.ts`; migrated `review.svelte.ts` repo file state from enum + error string to `RequestState<RepoFileData>`; updated `ReviewLayout.svelte` consumer
- S-005 — `deleteRepo` (now in `repos.svelte.ts`) restores only the repo, PRs and pins it removed; the review store's thread mutations roll back only the entity they touched
- S-004 — Renamed all `*FromWs` store handlers to `on<EventName>` in `review.svelte.ts`, `chat.svelte.ts`, and updated call sites in `ws.svelte.ts` (now `events.svelte.ts`)
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
- M-029 — Hand-rolled component `@keyframes` gone: walkthrough blocks, issue cards, stepper and spec-panel rows enter through `enterOnce` (w-walkthrough); the tool-activity group entrance is `in:gsapFadeY`, the push-pill pulse a GSAP tween, and RightPanel's duplicate `motion-essential-spin` was dropped (w-chat); ReviewTabs' status dot already pulsed through GSAP. The component keyframes left (`cell-pulse`, `footer-bounce`, `clone-pulse`, `grain-drift`) are on the surviving list in `motion/README.md`
- M-031 — Onboarding (`OnboardingShell`, `OnboardingFlow`, every `Step*`) entrances moved from component `@keyframes` to `gsapEnter`; `ProjectRail`'s folder unfold to `bitsAnim` + `collapsibleOpen/Close`; `Dotmatrix` and recaps' `scrollToTheme` read `prefersReducedMotion()` instead of their own `matchMedia`; `RepoAvatarButton`'s `clone-pulse` uses `--duration-pulse` and is on the surviving list
