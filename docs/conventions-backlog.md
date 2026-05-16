# Conventions Backlog

Every known violation of [`conventions.md`](./conventions.md), with a back-pointer to the rule
it breaks and a rough sizing for the fix. Worked top-to-bottom in the order suggested by the
default sort.

## Ranking dimensions

- **Severity**
  - **Blocking** — causes incorrect behavior in production today (data loss, fiber crashes
    that escape the supervisor, broken UI).
  - **High** — observable bug under stress or specific timing; latent correctness risk.
  - **Medium** — wrong-by-construction but no observed bug today; will trip a future refactor.
  - **Low** — purely stylistic / cosmetic drift.
- **Effort**
  - **XS** — under 30 minutes.
  - **S** — under 2 hours.
  - **M** — under one day.
  - **L** — over one day; may need its own design sketch.
- **Blast**
  - **Local** — one file.
  - **Module** — one domain (e.g. all server services, all onboarding components).
  - **Cross-cutting** — multiple domains or shared abstractions.

Default sort: **Severity desc → Blast desc → Effort asc** (quick wins on the highest-severity
items first). `blocks: <ID>` in Notes captures dependency between rows.

## Domains

Three top-level domains aligned with the conventions sections:

- **Server (Effect)** — IDs `E-###`
- **Web stores** — IDs `S-###`
- **UI / motion** — IDs `M-###`

Within each domain, rows are independent unless `Notes` says otherwise.

---

## Server (Effect)

<a id="e-001"></a>
### E-001 — OpencodeSupervisor schedules work via `Effect.runPromise` escape hatches

| Field | Value |
|---|---|
| **Rule** | [§2.2 Stay inside Effect](./conventions.md#effect-stay-inside) |
| **Location** | `apps/server/src/services/OpencodeSupervisor.ts:525`, `:672`, `:677`, `:734` |
| **Severity** | High |
| **Effort** | M |
| **Blast** | Local |
| **Notes** | `:525` is a `proc.exited.then(...)` handler that launches an unsupervised fiber; `:672–681` is the idle-timer pattern (`Effect.sync` wrapping `void Effect.runPromise` of a `setTimeout` that itself runs another `runPromise`); `:734` is fire-and-forget restart. Replace with `Effect.fork(Effect.tryPromise(() => proc.exited))` for exit observation, and `Effect.fork(Effect.sleep(IDLE_COOLDOWN_MS).pipe(Effect.andThen(stopIfIdle)))` for idle scheduling, both rooted in the supervisor's own scope so cleanup composes. |

<a id="e-002"></a>
### E-002 — WalkthroughJobs and ChatChangesPush bridge through `Effect.runPromise` in their main loop

| Field | Value |
|---|---|
| **Rule** | [§2.2 Stay inside Effect](./conventions.md#effect-stay-inside) |
| **Location** | `apps/server/src/services/WalkthroughJobs.ts:592`, `:620`, `:625`, `:701`, `:702`, `:759`, `:791`, `:807`, `:819`, `:863`; `apps/server/src/services/ChatChangesPush.ts:372`, `:1142–1160` |
| **Severity** | High |
| **Effort** | L |
| **Blast** | Module |
| **Notes** | The outer scope is `Effect.gen`, but the inner async loop uses `await Effect.runPromise(...)` for every DB read/write and status transition. This means cancellation does not propagate into the inner loop and errors surface as defects. Refactor: convert the inner loop body to Effect (likely via `Effect.iterate` or a recursive `Effect.gen`) so the outer fiber owns the work. Out of scope: the callback-shaped `onSessionId` / `issueOpencodeSessionToken` callbacks at `WalkthroughJobs.ts:490–514` — those are the legitimate SDK-interop boundary (§2.2 "Allowed boundary"). |

~~E-003~~ — closed (see [Closed](#closed))

<a id="e-004"></a>
### E-004 — Cache.ts performs raw Drizzle calls inside Effect.gen bodies

| Field | Value |
|---|---|
| **Rule** | [§2.4 Wrap Drizzle calls inside Effect.tryPromise](./conventions.md#effect-wrap-drizzle) |
| **Location** | `apps/server/src/services/Cache.ts:119–126` (select), `:136–138` (delete), `:170–182` (insert/upsert), `:191`, `:198–200` (invalidate deletes), `:257` (sweep delete), `:259` (select scan) |
| **Severity** | Medium |
| **Effort** | M |
| **Blast** | Local |
| **Notes** | Wrap each chain in `Effect.try({ try, catch })` (synchronous `.get()` / `.run()`) and define a `CacheDbError` tag in `domain/errors.ts`. Existing `Effect.runtime / Runtime.runPromise` block at `:227–235` is a legitimate Promise-dedup boundary for `getOrFetch` — leave it alone. |

<a id="e-005"></a>
### E-005 — Other services leak raw Drizzle calls — cross-cutting

| Field | Value |
|---|---|
| **Rule** | [§2.4 Wrap Drizzle calls inside Effect.tryPromise](./conventions.md#effect-wrap-drizzle) |
| **Location** | `apps/server/src/services/Walkthrough.ts:434`, `:458`, `:462`, `:504`, `:509`, `:616`, `:682`, `:692`, `:701`, `:709`; plus the same pattern in `Review.ts`, `PullRequest.ts`, `GitHubEtagCache.ts`, `FileContent.ts`, `DiffCache.ts`, `DbMaintenance.ts`, `ChatSession.ts` (one site each — files identified by grep, lines not enumerated) |
| **Severity** | Medium |
| **Effort** | L |
| **Blast** | Cross-cutting |
| **Notes** | Same fix recipe as E-004. Consider a thin `DbService` helper like `DbService.tryRun(() => db.x(...))` that returns `Effect<T, DbError>` so callers don't repeat the wrap boilerplate. `blocks: nothing` — each file can migrate independently once the helper exists. |

---

## Web stores

<a id="s-001"></a>
### S-001 — review.svelte.ts: prViewStates plain Map plus duplicated `$state` mirrors

| Field | Value |
|---|---|
| **Rule** | [§4.2 Per-PR keyed state](./conventions.md#stores-per-pr-state) |
| **Location** | `apps/web/src/lib/stores/review.svelte.ts:417` (`prViewStates = new Map<string, PrViewState>()`), `:420–421` (`let activeTab = $state(...)` + `let activeFilePath = $state(...)` mirrors), `:423–429` (`getOrCreate`), `:432–469` (setter sync logic) |
| **Severity** | Medium |
| **Effort** | M |
| **Blast** | Local |
| **Notes** | Two sources of truth for the same state: the non-reactive `prViewStates` Map AND the `$state`-backed `activeTab` / `activeFilePath` mirrors. Migrate to a single `store = $state({ entries: new Map<string, PrViewState>(), activePrId })` shape with `setEntry/deleteEntry/updateEntry` helpers matching the walkthrough store. Eliminate the mirror fields; derive current tab/file from the active entry. |

<a id="s-002"></a>
### S-002 — chat.svelte.ts: nine parallel per-PR Maps need a canonical mutation surface

| Field | Value |
|---|---|
| **Rule** | [§4.2 Per-PR keyed state](./conventions.md#stores-per-pr-state) |
| **Location** | `apps/web/src/lib/stores/chat.svelte.ts:113`, `:114`, `:117`, `:122`, `:140`, `:163`, `:1270`, `:1344`, `:1384` |
| **Severity** | Low |
| **Effort** | M |
| **Blast** | Local |
| **Notes** | Each Map currently has its own ad-hoc action functions. Audit whether they obey the reactive-Map idiom (§4.3) consistently, and whether to unify to a `setEntry/deleteEntry/updateEntry` per Map (or aggregate into a `store = $state({ chat: {...}, errors: {...}, ... })` with one mutation surface). Today's pattern works but compounds future maintenance. |

<a id="s-003"></a>
### S-003 — Request-state triplet is reinvented per store; `RequestState<T>` not introduced yet

| Field | Value |
|---|---|
| **Rule** | [§4.4 Request-state triplet](./conventions.md#stores-request-state) |
| **Location** | `apps/web/src/lib/stores/review.svelte.ts:70–76` (`repoFileStatus` enum + `repoFileError: string \| null`); `apps/web/src/lib/stores/walkthrough.svelte.ts:48–49` (`isStreaming: boolean` + `streamError: string \| null` + separate `summary/blocks/issues`); various other stores follow ad-hoc shapes |
| **Severity** | Medium |
| **Effort** | M |
| **Blast** | Cross-cutting |
| **Notes** | First fix PR introduces `apps/web/src/lib/stores/_types.ts` with `RequestState<T> = { status: 'idle' } \| { status: 'loading' } \| { status: 'error'; error: string } \| { status: 'ok'; data: T }`. Then migrate stores one at a time (likely review first, then walkthrough state, then walkthrough-stream). Components branch on `state.status` exhaustively. |

~~S-004~~ — closed (see [Closed](#closed))

---

## UI / motion

### §5.1 — Canonical motion tokens (non-onboarding)

~~M-001~~ — closed (see [Closed](#closed))

~~M-002~~ — closed (see [Closed](#closed))

~~M-003~~ — closed (see [Closed](#closed))

~~M-004~~ — closed (see [Closed](#closed))

~~M-005~~ — closed (see [Closed](#closed))

~~M-006~~ — closed (see [Closed](#closed))

~~M-007~~ — closed (see [Closed](#closed))

### §5.2 — Ceremonial motion (onboarding scale migration)

~~M-008~~ — closed (see [Closed](#closed))

~~M-009~~ — closed (see [Closed](#closed))

~~M-010~~ — closed (see [Closed](#closed))

~~M-011~~ — closed (see [Closed](#closed))

~~M-012~~ — closed (see [Closed](#closed))

~~M-013~~ — closed (see [Closed](#closed))

~~M-014~~ — closed (see [Closed](#closed))

---

## Summary

| Domain | Open | Severity mix |
|---|---|---|
| Server (Effect) | 4 | 2× High, 2× Medium |
| Web stores | 3 | 3× Medium |
| UI / motion | 0 | — |
| **Total** | **7** | |

Default order to work remaining items: **E-001, E-002, E-004, E-005, S-001, S-002, S-003.**

This file is the source of truth for outstanding consistency work. As fixes land, replace each
row's table with a single line under a `## Closed` section at the bottom of the file
(`ID — short summary`) so the audit trail survives.

---

<a id="closed"></a>
## Closed

- E-003 — Added `OpencodeNotSelectedError` / `OpencodeUnhealthyError` to `domain/errors.ts`; migrated two `AiGenerationError` misuses in `OpencodeSupervisor.ts`
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
