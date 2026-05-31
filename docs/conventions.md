# Code Conventions

<a id="purpose"></a>
## 1. Purpose & Status

This document codifies the canonical patterns that Revv code is expected to follow. It exists
because the codebase already has strong implicit canon in several places — and weaker, divergent
practice in others — and future refactors are cheap only if everyone reaches for the same idiom
first.

**Status: convention-only.** There are no ESLint rules, biome custom checks, or type-level
guards enforcing the patterns below. Drift is caught at PR review time. If you find a rule
boring enough that you reach for an exception, open a PR amending this document instead — it's
shorter than the argument in code review.

Companion file: [`conventions-backlog.md`](./conventions-backlog.md) — every known existing
violation, ranked, with a back-pointer to the rule it violates. New violations should not
appear in code without a matching backlog row; new rules should not appear here without first
auditing the codebase for existing violations.

CLAUDE.md remains the load-bearing project guide. It cross-references this doc but stays
short — that file is meant to be skimmed cold; this one is meant to be searched.

Architecture companion: [`architecture.md`](./architecture.md) — the module map and narrow-neck
interfaces that this conventions file enforces.

---

<a id="effect-services"></a>
## 2. Effect Service Patterns

Server services in `apps/server/src/services/` are built on `effect`. The patterns below
preserve the type-level guarantees Effect provides; bypassing them turns Effect into expensive
ceremony with no payoff.

<a id="effect-service-naming"></a>
### 2.1 Service tag + Layer naming

**Rule.** A service named `XService` is declared as `class XService extends Context.Tag(...)`
and its concrete implementation is exported as `XServiceLive: Layer<...>`. No exceptions, no
default exports, no `Live`-less Layers.

**Why.** Composing the tag instead of the Layer is one of the easier mistakes in Effect, and a
mechanical naming rule eliminates the entire class. The `Live` suffix mirrors Effect community
convention.

**Canonical example.** `apps/server/src/services/Cache.ts:51` declares
`class CacheService extends Context.Tag("CacheService")<...>` and exports its implementation as
`CacheServiceLive = Layer.sync(CacheService, () => {...})` at `apps/server/src/services/Cache.ts:72`.
`WebSocketHub` / `WebSocketHubLive` at `apps/server/src/services/WebSocketHub.ts:9` and `:19`
follows the same shape.

**Anti-pattern.** `export const Cache = Layer.sync(...)` (Live suffix missing — caller can't
tell from the import whether they're getting the tag or the Layer).

**Backlog.** None — this rule is already-canon and no remediation is needed.

<a id="effect-stay-inside"></a>
### 2.2 Stay inside Effect

**Rule.** Inside a function that returns `Effect.Effect<...>`, do not call `Effect.runPromise`,
`Effect.runSync`, or `Runtime.runPromise`. Schedule callbacks with `Effect.fork`, time-delays
with `Effect.sleep` + `Effect.schedule`, and bridge external callback-based APIs with
`Effect.async` / `Effect.tryPromise`.

**Why.** `runPromise` synchronously starts a fresh fiber that the surrounding Effect cannot
observe, supervise, interrupt, or join. Errors in the inner Effect bypass the outer error
channel; cancellation does not propagate; ordering becomes non-deterministic under concurrency.
A service that uses `runPromise` inside its own methods loses the very properties Effect was
adopted for.

**Canonical example.** `apps/server/src/services/PollScheduler.ts:197` composes a long-running
loop entirely inside `Effect.gen`, using `Effect.forEach`, `Effect.tapError`, and
`Effect.catchTag` for branching — no `runPromise` escape hatches.

**Anti-pattern.** `apps/server/src/services/OpencodeSupervisor.ts:670–681` schedules an idle
timer with `Effect.sync(() => { void Effect.runPromise(...) })` and inside the `setTimeout`
callback recursively calls `void Effect.runPromise(stopIfIdle())`. The same file uses the
pattern again at `:525` for a `proc.exited.then(...)` handler. These should be replaced with
`Effect.fork(Effect.sleep(...).pipe(Effect.andThen(stopIfIdle)))` and a forked `proc.exited`
observer that yields back into the supervisor's fiber.

**Allowed boundary.** Bridging Effect into a plain-JS callback contract (e.g. SDK options that
take `(value: string) => void` rather than `(value: string) => Effect<...>`) is the one
legitimate place `Effect.runPromise` belongs. See `apps/server/src/services/WalkthroughJobs.ts:490`
where five `Effect.runPromise` calls live inside callback factories handed to `ai.streamWalkthrough`.
These are NOT violations — they are the SDK-interop boundary and the only way out without
rewriting the AI service's option surface. The rule is "no `runPromise` inside an Effect-returning
method" — wrapping a callback that the caller will invoke later is fine.

**Backlog.** [`E-001`](./conventions-backlog.md#e-001), [`E-002`](./conventions-backlog.md#e-002).

<a id="effect-tagged-errors"></a>
### 2.3 Tagged errors live in `domain/errors.ts`

**Rule.** Every domain failure mode declared anywhere in `apps/server/` is a
`Data.TaggedError` defined in `apps/server/src/domain/errors.ts` and exported from a union
type (`GitHubError`, `AiError`, `AppError`). No inline `class FooError extends Data.TaggedError` in
service files; no raw `throw new Error(...)` in Effect-returning methods.

**Why.** Centralizing tagged errors lets callers `Effect.catchTag("FooError", ...)` without
chasing definitions across the tree. Throwing raw Errors converts a typed failure into a defect
(uncaught fiber crash); Effect can recover from `Effect.fail` but only crashes on `Effect.die`.

**Canonical example.** `apps/server/src/domain/errors.ts:1–105` declares every error class
used by the server, grouped by domain (GitHub, Auth, Clone, AI, Review, Sync) and re-exported
as union types. Consumers `catchTag` against the string tag (e.g. `Effect.catchTag("GitHubAuthError", ...)`).

**Anti-pattern.** Defining a one-off `class LocalError extends Data.TaggedError(...)` inline in
a service file, or returning `Effect.fail(new Error("..."))` (untagged — defeats `catchTag`).
Also: `apps/server/src/services/OpencodeSupervisor.ts:576` wraps the actionable failure as
`new AiGenerationError({ cause: new Error("selected agent is '${agent}'...") })`. Reusing
`AiGenerationError` for an "agent-selection mismatch" semantically distinct failure dilutes
what the tag means; a dedicated `OpencodeNotSelectedError` would let callers branch.

**Backlog.** [`E-003`](./conventions-backlog.md#e-003).

<a id="effect-wrap-drizzle"></a>
### 2.4 Wrap Drizzle calls inside Effect.tryPromise

**Rule.** Any `db.select / insert / update / delete` chain that lives inside an
`Effect.gen` body must be wrapped in `Effect.tryPromise({ try, catch })` (or `Effect.try` for
the synchronous `.get()` / `.run()` variants) and the `catch` must map to a tagged error.

**Why.** Drizzle's synchronous `.get()` / `.run()` and asynchronous `.execute()` can throw —
constraint violations, locked tables, schema drift, SQLite IO errors. An unwrapped call inside
`Effect.gen` lets the throw escape as an Effect *defect*, not a *failure*: callers expecting to
`catchTag` on a typed DB error get a fiber crash instead.

**Canonical example.** `apps/server/src/services/PollScheduler.ts:176–184` wraps a
`db.update(user).set(...).where(...).run()` chain with
`Effect.try({ try: ..., catch: (e) => new Error(String(e)) }).pipe(Effect.orElseSucceed(...))`.
The `.orElseSucceed` is the deliberate fallback for "this update is best-effort"; replace it with
`Effect.fail(new <DbError>(...))` when the caller should care.

**Anti-pattern.** `apps/server/src/services/Cache.ts:119–126`, `:136–138`, and `:170–182` call
`db.select(...).get()`, `db.delete(...).run()`, and `db.insert(...).onConflictDoUpdate(...).run()`
directly inside `Effect.gen` bodies — any synchronous throw bypasses Effect's error channel.
Same pattern in `Walkthrough.ts` and `Db.ts` consumers.

**Backlog.** [`E-004`](./conventions-backlog.md#e-004), [`E-005`](./conventions-backlog.md#e-005).

---

<a id="module-boundaries"></a>
## 2.5 Module Boundary Rules

The server architecture is documented in [`architecture.md`](./architecture.md). The rules below
are the import-direction guardrails for keeping those modules deep.

<a id="feature-pr-context"></a>
### 3.1 Feature modules use PR Context

**Rule.** Walkthrough, Chat, and Recap feature modules must not import `GitHubService`,
`RepositoryService`, or `TokenProvider` directly. PR-scoped GitHub context flows through
`PrContextService`.

**Why.** Feature modules should express product lifecycle and user workflow logic, not token
lookup, repository ownership, GitHub API calls, or account fallback rules. `PrContextService`
is the narrow seam that hides that platform detail.

**Enforcement.** `bun run check:import-boundaries` is part of `bun run lint`. It rejects new
direct imports and lists the remaining legacy exceptions explicitly in the script while later
waves migrate them.

**Canonical example.** `WalkthroughJobs` depends on `PrContextService` for PR/repo/token/diff
context before starting a walkthrough job.

**Anti-pattern.** A chat or recap route importing `GitHubService` to fetch PR metadata or
`TokenProvider` to resolve an access token.

<a id="settings-agent-resolution"></a>
### 3.2 Settings owns provider selection

**Rule.** Code that needs the effective CLI agent calls `SettingsService.resolveAgent()` or
`SettingsService.resolveRecapAgent()`. AI-provider modules may branch on the returned agent, but
they do not own fallback or validation rules.

**Why.** Agent choice is a settings concern. Keeping it in one service prevents drift between
walkthroughs, chat, recaps, model listing, session lookup, and daemon lifecycle.

**Backlog.** The daemon lifecycle still has provider-specific mechanics in feature code until the
later AI-provider and job-helper waves.

---

<a id="ws-envelopes"></a>
## 3. WebSocket Envelope Conventions

All cross-process socket traffic between the Elysia server and the SvelteKit web client is
shaped by the discriminated union in `packages/shared/src/ws.ts`. This is the canonical source
of truth — anything else is divergence.

<a id="ws-envelope-shape"></a>
### 3.1 Envelope shape is `{ type, data? }`

**Rule.** Every server-to-client message is a discriminated union arm of `WsServerMessage`
with shape `{ type: string; data?: object | array }`. No flat fields hoisted to the top level;
no alternative discriminator names (`event`, `kind`); no top-level payload fields outside `data`.
Messages with no payload omit `data` entirely rather than passing `data: null`.

**Why.** A single envelope shape lets the frontend dispatcher (`apps/web/src/lib/stores/ws.svelte.ts`)
exhaustively switch on `msg.type` with `noUncheckedIndexedAccess`-friendly types. Adding a flat
field means every consumer needs to know which arms carry it.

**Canonical example.** `packages/shared/src/ws.ts:13–90` defines 25+ message arms, all conforming
to `{ type, data? }`. Signal-only arms (`prs:sync-started` at `:15`) omit `data`; payload-bearing
arms (`prs:sync-complete` at `:16`) carry a structured `data` object.

**Anti-pattern.** `{ type: "thing-happened", thing: { ... } }` (flat `thing` instead of nested
in `data`). Or `{ event: "thing-happened", data: ... }` (`event` instead of `type`).

**Nested payload note.** Embedding a typed sub-envelope inside `data` is fine when it carries
real meaning. `walkthrough:edited` at `packages/shared/src/ws.ts:62–69` wraps a
`WalkthroughStreamEvent` inside `data` so the frontend can reuse the SSE reducer code path —
this is consistent with the rule (the outer shape is still `{ type, data }`) and is documented
in code.

**Backlog.** None — current canon is clean.

<a id="ws-envelope-naming"></a>
### 3.2 Type names are `namespace:action`, lowercase, kebab-cased

**Rule.** Message type strings use colon-separated namespace and action segments. Segments are
lowercase ASCII letters with hyphens between words. The namespace is the entity (`prs`, `thread`,
`threads`, `walkthrough`, `repos`, `user`, `chat`, `error`); the action is the verb
(`updated`, `created`, `sync-started`, `clone-status`, `question-resolved`).

**Why.** Easy to grep, easy to scan, no Ambiguity-About-Casing arguments. Bonus: `:` is illegal
in most identifiers, so message types can never accidentally collide with frontend variable
names.

**Canonical example.** Every entry in `packages/shared/src/ws.ts:13–90` follows the rule
(`prs:updated`, `repos:clone-status`, `thread:message:edited` at `:72`).

**Anti-pattern.** `prsUpdated`, `PRS_UPDATED`, `prs.updated`, or routing on a generic
`message-type` discriminator field that holds free-form strings.

**Backlog.** None — current canon is clean.

<a id="ws-payload-semantics"></a>
### 3.3 Pick one payload contract: signal, full-state, delta

**Rule.** Each WS message arm declares exactly one of three semantic contracts:

- **Signal** — no `data`. The receipt of the message is the entire signal. Example:
  `prs:sync-started`. Receivers re-fetch authoritative state from the DB.
- **Full-state** — `data` carries the entire new state for some entity or list. Receivers
  replace, they do not merge. Example: `prs:updated` carries the full `PullRequest[]`.
- **Delta** — `data` carries an instruction the receiver applies to existing state. Example:
  `thread:message` carries `{ threadId, message }` to append. Receivers must be safe to drop
  during disconnect and reconcile via the broadcast contract (CLAUDE.md invariant #8).

The choice is documented at the type definition.

**Why.** Frontend consumers wire reducers to one of three shapes. A message that "kinda" carries
state and "kinda" carries deltas needs custom handler logic per consumer.

**Canonical example.** Three arms of `packages/shared/src/ws.ts` illustrating each:
`prs:sync-started` (signal, `:15`); `prs:updated` (full-state, `:14`); `thread:message`
(delta, `:45`).

**Anti-pattern.** Mixing — e.g. a `repos:partial-update` message that sometimes carries the
full list and sometimes carries one repo. Receivers can't tell whether to replace or merge.

**Broadcast contract.** All WS broadcasts are best-effort and lossy. The hub's contract is
documented in code at `apps/server/src/services/WebSocketHub.ts:36–45`: receivers reconcile
from the DB on reconnect; never derive authoritative display state exclusively from WS
messages. This is CLAUDE.md invariant #8.

**Backlog.** None — current canon is clean.

---

<a id="stores"></a>
## 4. Web Store Patterns

Svelte 5 stores under `apps/web/src/lib/stores/` are how reactive state crosses component
boundaries. The canon below is what `walkthrough.svelte.ts`, `prs.svelte.ts`, and `auth.svelte.ts`
already do; `review.svelte.ts`, `sync.svelte.ts`, and the in-progress
`walkthrough-stream.svelte.ts` are the migration targets.

<a id="stores-singleton"></a>
### 4.1 Singleton module + getX/setX exports

**Rule.** A store is a module that declares its reactive state at module-scope (with `$state`)
and exposes it through named `get<Field>()` getters and `set<Field>()` / verb-prefixed action
exports. No factory functions, no classes, no `useFoo()` hooks. Action exports are verb-first
(`setSelectedPrId`, `markThreadsSyncing`); read accessors are noun-first (`getThreads`,
`getActiveTab`).

**Why.** Svelte 5 runes mean modules ARE the reactive boundary. Wrapping that in a factory
imports a React mental model that the framework doesn't share. The getter/setter split keeps
consumers from importing `$state` proxies directly, which would let components mutate stores
in ways the store doesn't control.

**Canonical example.** `apps/web/src/lib/stores/sync.svelte.ts:5–22` declares module-scope
`$state` and exposes only `getSummary`, `getLastSyncAt`, `markThreadsSyncing`, etc.
`apps/web/src/lib/stores/walkthrough.svelte.ts:144` exports a single `store` object as the
reactive root — also acceptable for stores with many related fields, but the getter discipline
still applies (`getBlocks`, `getIssues`, etc. at `:188`+).

**Anti-pattern.** `export function createWalkthroughStore() { ... }` returning an object with
methods — the consumer instantiates per-component and reactive sharing across components breaks.

**Backlog.** None — current canon is clean.

<a id="stores-per-pr-state"></a>
### 4.2 Per-PR keyed state is `Map<prId, Entry>` with shared mutation helpers

**Rule.** Stores that hold per-PR state expose a `Map<string, Entry>` keyed on `prId` and
provide three mutation helpers: `setEntry(prId, entry)`, `deleteEntry(prId)`,
`updateEntry(prId, updater)`. Multiple per-PR maps inside one store (`summaries`,
`lastSyncAtByPr`, `syncErrorByPr`) is allowed when fields have independent lifecycles, but each
gets its own mutation helper that obeys the reactive-Map idiom (§4.3).

**Why.** Three competing shapes for "PR-keyed state" exist today (`prViewStates`, `entries`,
`summaries/lastSyncAtByPr/syncErrorByPr`). Picking one means future per-PR stores compose
trivially with existing dispatchers and don't reinvent the API surface.

**Canonical example.** `apps/web/src/lib/stores/walkthrough.svelte.ts:144` declares
`store = $state({ entries: new Map<string, WalkthroughEntry>(), activePrId: ... })`; the helpers
`setEntry` (`:167`), `deleteEntry` (`:172`), and `updateEntry` (`:177`) own all writes. The
in-file comment at `:129–142` documents the idiom and the Svelte 5 reactivity rationale —
required reading before adding a new keyed store.

**Anti-pattern.** `apps/web/src/lib/stores/review.svelte.ts:417` keeps `prViewStates = new Map<string, PrViewState>()`
as a non-reactive plain Map plus a separate `let activeTab = $state(...)` mirror that has to
be hand-synced via `getOrCreate(prId).activeTab = tab` in every setter. Two sources of truth
for the same state.

**Backlog.** [`S-001`](./conventions-backlog.md#s-001), [`S-002`](./conventions-backlog.md#s-002).

<a id="stores-reactive-map"></a>
### 4.3 Reactive Map mutation: `.set/delete` then reassign

**Rule.** Every write to a `$state`-backed Map or Set is followed by a reassignment:
`m.set(k, v); m = new Map(m);`. The same applies to nested Maps/Sets reached through a `$state`
object: `store.entries.set(k, v); store.entries = new Map(store.entries);`. In-place mutation
without reassignment is silently non-reactive in Svelte 5.

**Why.** Svelte 5's `$state` proxy intercepts property writes on the proxied object, but does
not currently track raw `.set/.delete` calls on a `Map`/`Set` it wraps. Reassigning forces a
write through the proxy and triggers invalidation. This is documented in code at
`walkthrough.svelte.ts:137–142` — the comment cites the bug that motivated the idiom.

**Canonical example.** `apps/web/src/lib/stores/walkthrough.svelte.ts:167–184` — every
`setEntry` / `deleteEntry` / `updateEntry` ends with `store.entries = new Map(store.entries)`.
`apps/web/src/lib/stores/sync.svelte.ts:51–62` does the same pattern with multiple Maps and Sets
in a single helper.

**Anti-pattern.** `someMap.set(k, v)` with no follow-up reassignment. The state mutates, but
no consumer recomputes. Showed up as a Floating Action Button stuck on "Stop" until a tab
switch invalidated derivations — the exact bug the comment in `walkthrough.svelte.ts:154–159`
warns about.

**Backlog.** Existing reactive-Map sites in `review.svelte.ts` already follow the idiom — no
remediation needed today. The rule is a guardrail for future writes.

<a id="stores-request-state"></a>
### 4.4 Request-state triplet uses a shared `RequestState<T>` type

**Rule.** When a store represents the lifecycle of an async load (loading → success | error),
model it as a tagged union `RequestState<T> = { status: 'idle' } | { status: 'loading' } | { status: 'error'; error: string } | { status: 'ok'; data: T }`,
not as parallel boolean flags + nullable error/data fields. The `RequestState<T>` type lives at
`apps/web/src/lib/stores/_types.ts` (to be created in the first store-domain fix PR; this
conventions doc declares the shape, the type is introduced when the first migration ships).

**Why.** Boolean triplet (`isLoading` + `error: string | null` + `data: T | null`) admits
illegal states like `{ isLoading: true, error: "foo", data: T }`. A tagged union forces
exhaustive `switch (state.status)` handling in components and produces narrower types
downstream.

**Canonical example.** Today, no store in the codebase uses a `RequestState<T>` type — this
rule is forward-looking. The closest existing shape is the enum + string error pair in
`apps/web/src/lib/stores/review.svelte.ts:70–76` (`repoFileStatus` enum +
`repoFileError: string | null`), which approximates the pattern but does not bundle the data
into the same value.

**Anti-pattern.** Boolean + nullable shape from
`apps/web/src/lib/stores/walkthrough.svelte.ts:48–49`: `isStreaming: boolean; streamError: string | null`
plus separate `summary: string | null; blocks: WalkthroughBlock[]`. The four fields form 16
possible combinations; only ~4 are legal.

**Backlog.** [`S-003`](./conventions-backlog.md#s-003).

<a id="stores-ws-handlers"></a>
### 4.5 WS message handlers in stores are named `on<EventName>`

**Rule.** Functions exported from a store for the WS dispatcher (`ws.svelte.ts`) to call follow
the form `on<EventName>` where `<EventName>` is the WS message `type` with the colon dropped
and segments PascalCased (`thread:created` → `onThreadCreated`; `walkthrough:edited` →
`onWalkthroughEdited`). One handler per WS message arm.

**Why.** Reading the dispatcher should make it obvious which store owns which message. The
`*FromWs` suffix style buries the event identity in the middle of the name and pluralizes
inconsistently (`updateThreadStatusFromWs` vs the WS type `thread:updated`).

**Canonical example.** `apps/web/src/lib/stores/walkthrough.svelte.ts:444`
(`onWalkthroughError`), `:461` (`onWalkthroughEdited`), and
`apps/web/src/lib/stores/walkthrough-stream.svelte.ts:601` (`onWalkthroughComplete`) match the
WS message types `walkthrough:error`, `walkthrough:edited`, `walkthrough:complete`.

**Anti-pattern.** `apps/web/src/lib/stores/review.svelte.ts:660` `updateThreadStatusFromWs`,
`:677` `addThreadFromWs`, `:695` `addMessageFromWs`, `:933` `updateMessageFromWs`. Same pattern
in `apps/web/src/lib/stores/chat.svelte.ts` (`resolveQuestionFromWs`).

**Migration form.** `updateThreadStatusFromWs` → `onThreadUpdated`; `addThreadFromWs` →
`onThreadCreated`; `addMessageFromWs` → `onThreadMessage`; `updateMessageFromWs` →
`onThreadMessageEdited`; `removeMessageFromWs` → `onThreadMessageDeleted`; `removeThreadFromWs` →
`onThreadDeleted`; `resolveQuestionFromWs` → `onChatQuestionResolved`.

**Backlog.** [`S-004`](./conventions-backlog.md#s-004).

<a id="stores-optimistic"></a>
### 4.6 Client-initiated mutations are optimistic with entity-scoped rollback

**Rule.** A store function that wraps a server mutation flips local state immediately, awaits
the API call, and on error restores the same entity's prior fields. Rollback captures *the
specific fields being mutated on the specific entities involved* — never a list snapshot. If
the calling component branches on the throw (loading spinners, inline errors), the function
rethrows after the toast; otherwise it may swallow.

**Why.** Two reasons. (1) **UI lag.** Waiting for the server round-trip plus the WS
rebroadcast before reflecting the user's action is the laggy-feel symptom this rule
eliminates — closing a PR, flipping draft state, merging, pinning should feel
instantaneous because the outcome is rarely in doubt. (2) **Concurrency.** A `prs:updated`
arriving during the optimistic window can legitimately add or remove *other* entities.
List-snapshot rollback (`pullRequests = openSnapshot`) would clobber those updates and
re-introduce entities the server has since removed. Restoring only the fields you changed
on the entity you touched is resilient to whatever else arrives over the wire.

**Canonical example.** `apps/web/src/lib/stores/prs.svelte.ts:338-362` — `pinPr` and
`unpinPr` capture the single field they mutate (`pinnedPrIds` membership), apply,
and restore on throw. The four owner-only PR mutations (`convertPrToDraft`,
`markPrReadyForReview`, `closePr`, `mergePr`) in the same file follow the same shape
with more fields involved: draft flip uses a single-field local helper; close/merge reuse
the existing `onPrArchived` for the forward open→archived move and `restorePrFromArchive`
for the reverse rollback. Both helpers touch exactly one PR per call so concurrent
`prs:updated` broadcasts that reshuffle the rest of the list survive intact.

**Anti-pattern.** `apps/web/src/lib/stores/prs.svelte.ts:455-487` — `deleteRepo` snapshots
`repositories`, `pullRequests`, `archivedPrs`, `taggedPrsByRepo`, and `pinnedPrIds` whole
via `snapshotRepoState()`, restores them whole on error via `restoreRepoState()`. The
shape works for the rare single-entity-delete case it lives in, but it does not generalize:
any concurrent WS broadcast between snapshot and rollback is silently dropped. The fix is
entity-scoped removal — capture the removed repo, the removed PR ids, and the removed
pinned ids — and inverse them on rollback rather than restoring the whole world.

**Backlog.** [`S-005`](./conventions-backlog.md#s-005).

---

<a id="ui-motion"></a>
## 5. UI & Motion Conventions

The motion rules in CLAUDE.md are the authoritative summary. This section restates them with
examples and records the decision on the onboarding's parallel motion scale (see §5.2).

<a id="motion-tokens"></a>
### 5.1 Use canonical motion tokens, never hand-typed values

**Rule.** All `transition` and `animation` durations come from the `@theme` block in
`apps/web/src/app.css`:

- `--duration-snap: 120ms` — chevrons, badges, small surfaces
- `--duration-quick: 160ms` — default UI motion
- `--duration-smooth: 220ms` — panels, sidebars, larger reveals
- *(ceremonial tier — see §5.2)*

Easings come from:

- `--ease-soft: cubic-bezier(0.4, 0, 0.2, 1)` — exits, bidirectional state
- `--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1)` — enter / appearance
- `--ease-standard: cubic-bezier(0.22, 0.61, 0.36, 1)` — walkthrough chapters

Reference them in CSS as `var(--duration-quick) var(--ease-out-expo)` or via Tailwind
utilities (`duration-quick`, `ease-out-expo`). No literal `cubic-bezier(...)`, no
`220ms`/`300ms`/`0.55s` magic numbers, no `ease-in` shorthand.

**Why.** The motion language is a shipped product surface. Bespoke easings drift away from the
brand voice; bespoke durations make screens feel uneven. Canonical tokens also collapse
correctly under `prefers-reduced-motion` (see CLAUDE.md).

**Canonical example.** `apps/web/src/lib/components/layout/Sidebar.svelte:605–608` uses
`transition: opacity var(--duration-quick) var(--ease-out-expo) 60ms, transform var(--duration-quick) var(--ease-out-expo) 60ms`.

**Anti-pattern.** `apps/web/src/lib/components/walkthrough/IssueCard.svelte:155`:
`animation: issue-card-enter 0.55s cubic-bezier(0.22, 0.61, 0.36, 1) both;` — both the
duration and the easing are literals. The easing is byte-identical to `--ease-standard`; the
duration has no canonical equivalent.

**Backlog.** [`M-001`](./conventions-backlog.md#m-001) through
[`M-007`](./conventions-backlog.md#m-007).

<a id="motion-ceremonial"></a>
### 5.2 Ceremonial motion has its own tier — but in the main scale

**Rule.** Onboarding's deliberately slow, theatrical motion uses three ceremonial tokens added
to the SAME `@theme` block in `app.css`:

- `--duration-ceremonial-quick: 280ms` — current `--ob-dur-quick`
- `--duration-ceremonial-medium: 480ms` — current `--ob-dur-medium`
- `--duration-ceremonial-slow: 720ms` — current `--ob-dur-slow`

The eases reuse the existing canonical tokens (`--ease-out-expo` and `--ease-standard` are
already byte-identical to the onboarding's `--ob-ease-out` and `--ob-ease` respectively).

The parallel `--ob-*` scale in `apps/web/src/lib/components/onboarding/OnboardingShell.svelte:144–148`
is retired. Onboarding components migrate to the ceremonial tokens.

**Why.** A parallel scale was tried and failed: `--ob-*` exists, but most onboarding components
hand-type unrelated values (`800ms`, `1200ms`, `760ms`, `540ms`, `600ms`) that don't reference
the scale at all. Folding ceremonial into the main scale gives a single source of truth and
removes the temptation to mix-and-match.

**Decision rationale.** Considered: (a) keep `--ob-*` as a documented sibling scale and treat
non-conforming onboarding values as violations; (b) fold into the main scale. Picked (b)
because the parallel scale has not, in practice, prevented drift and adds cognitive load for
no observable benefit. The eases are already shared; only the durations needed addition.

**Use outside onboarding.** Ceremonial durations are valid anywhere the motion is genuinely
slow and intentional — empty-state illustrations, success-celebration moments, hero reveals.
They are not a fallback for "I want this longer" — that's almost always `--duration-smooth`.

**Canonical example.** Will exist once the §5.2 fix PR lands. Today, the closest legal
approximation is `apps/web/src/lib/components/onboarding/StepRepo.svelte:531` which uses the
canonical `var(--duration-smooth, ...) var(--ease-out-expo, ...)` with literal fallbacks — the
fallbacks are violations, but the primary reference is correct.

**Anti-pattern.** `apps/web/src/lib/components/onboarding/StepDone.svelte:73, 96`:
`animation: scene-in 800ms cubic-bezier(...)`, `animation: fin-in 1200ms cubic-bezier(...) 600ms backwards`.
Hand-typed durations that match no token, in the same file as 1200ms which also matches none.

**Backlog.** [`M-008`](./conventions-backlog.md#m-008) through
[`M-014`](./conventions-backlog.md#m-014).

<a id="motion-icon-only"></a>
### 5.3 Icon-only policy (cross-reference)

The "always use icons, never emojis" rule lives in CLAUDE.md and is fully honored — zero
violations in the codebase. Use `phosphor-svelte` components or inline SVG for brand/octicon
marks; no emoji glyphs in rendered UI, toasts, or component text.

**Backlog.** None.

---

<a id="components"></a>
## 6. Svelte Component Patterns

<a id="components-props"></a>
### 6.1 Props are declared via `interface Props` + `$props()`

**Rule.** Every Svelte 5 component declares its props through:

```svelte
<script lang="ts">
interface Props {
  prId: string;
  isActive?: boolean;
}
let { prId, isActive = true }: Props = $props();
</script>
```

No `export let prop`; no inline-typed `$props<{...}>()`; no `Pick`/`Omit` types from elsewhere
unless the source is a shared component prop interface.

**Why.** Already universal (verified across 179/179 components in the audited directories).
Codifying it locks the canon so future contributors don't reach for Svelte-4 syntax.

**Canonical example.** Any component under `apps/web/src/lib/components/walkthrough/`
demonstrates the pattern. `GuidedWalkthrough.svelte:64–70` is representative.

**Backlog.** None — already-canon.

<a id="components-events"></a>
### 6.2 Event handlers use `onclick={fn}` property-style

**Rule.** Use Svelte-5-style lowercase property bindings (`onclick={handler}`,
`onsubmit={handleSubmit}`). No `on:click` directives (Svelte 4); no `handleClick` naming
convention for inline arrows — bind a named function or inline an arrow directly.

**Why.** Already universal; `on:click` directives are 0 occurrences in the audited components.
Lowercase-property bindings interop with native DOM event names without a custom dispatcher
layer.

**Canonical example.** `GuidedWalkthrough.svelte` uses `onclick={handleRegenerate}` on its
Button instances; `IssueCard.svelte` uses `onclick={selectIssue}` consistently.

**Backlog.** None — already-canon.

---

<a id="process"></a>
## 7. Proposing a New Convention

Open a PR editing this file. No RFC ceremony, no `docs/proposals/` staging area. The PR
description should explain:

1. What rule you want to codify.
2. Whether existing code already follows it (then this is a documentation patch) or whether
   it's a behavior change (then add backlog rows for the existing violations).
3. The smallest change to the existing canon you can get away with — extensions, not rewrites.

Drift in this file is fine. Drift in the codebase is what the
[backlog](./conventions-backlog.md) tracks.
