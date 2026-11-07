# Code Conventions

<a id="purpose"></a>
## 1. Purpose & Status

This document codifies the canonical patterns that Revv code is expected to follow. It exists
because the codebase already has strong implicit canon in several places — and weaker, divergent
practice in others — and future refactors are cheap only if everyone reaches for the same idiom
first.

**Status.** Most rules are caught at PR review. Some are enforced by `bun run lint`:
`check:import-boundaries` (§2.5.1, §3.4, the git and GitHub-transport boundaries, and the
`gsap` import of §5), `check:motion-tokens` (§5.1's generated `tokens.ts`),
`check:desktop-contract` (every port, path and name shared with Rust, JSON, shell and Nix) and
`check:migrations`. If you find a rule boring enough that you reach for an exception, open a PR
amending this document instead — it's shorter than the argument in code review.

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

**Rule.** A service tag is declared as `class X extends Context.Service<Self, Shape>()("X")` and
its concrete implementation is exported as `XLive: Layer<...>`. The tag is named `XService` when
the bare name would clash with a domain type or table (`PullRequestService`, `SettingsService`),
and its Layer is then `XServiceLive`. No default exports, no `Live`-less Layers.

**Why.** Composing the tag instead of the Layer is one of the easier mistakes in Effect, and a
mechanical naming rule eliminates the entire class. The `Live` suffix mirrors Effect community
convention.

**Dependencies are captured when the Layer is built.** A service reads what it needs, `DbService`
included, once, in its `Layer.effect` body, and returns `X.of({ … })` with methods that close over
it. Its methods' requirement type is therefore `never`, and no caller provides anything per call.
Plain functions a service calls take the handle as an argument (`hunk-scan/store.ts`:
`getHunkScan(db, key)`). Only code that runs straight off the app runtime, such as route handlers
and the helpers they call (`review-mode.ts`, `walkthrough/perspective.ts`), reads `DbService`
where it needs it.

**Canonical example.** `Realtime` / `RealtimeLive` (`services/Realtime.ts`) and `CacheService` /
`CacheServiceLive` (`services/Cache.ts`).

**Anti-pattern.** `export const Cache = Layer.sync(...)` (Live suffix missing — caller can't
tell from the import whether they're getting the tag or the Layer).

**Backlog.** None — this rule is already-canon and no remediation is needed.

<a id="effect-stay-inside"></a>
### 2.2 Stay inside Effect

**Rule.** Inside a function that returns `Effect.Effect<...>`, do not call `Effect.runPromise`,
`Effect.runSync`, or `Effect.runPromiseWith`. Schedule callbacks with `Effect.forkChild`, time-delays
with `Effect.sleep` + `Effect.schedule`, and bridge external callback-based APIs with
`Effect.callback` / `Effect.tryPromise`.

**Why.** `runPromise` synchronously starts a fresh fiber that the surrounding Effect cannot
observe, supervise, interrupt, or join. Errors in the inner Effect bypass the outer error
channel; cancellation does not propagate; ordering becomes non-deterministic under concurrency.
A service that uses `runPromise` inside its own methods loses the very properties Effect was
adopted for.

**Canonical example.** `PollScheduler.syncAllRepos` (`services/PollScheduler.ts`) composes a
long-running loop entirely inside `Effect.gen`, using `Effect.forEach`, `Effect.tapError`, and
`Effect.catchTag` for branching — no `runPromise` escape hatches.

**Anti-pattern.** An idle timer scheduled with `Effect.sync(() => { void Effect.runPromise(...) })`,
or a `proc.exited.then(() => void Effect.runPromise(...))` handler. Use
`Effect.forkChild(Effect.sleep(...).pipe(Effect.andThen(stopIfIdle)))` and a forked observer
of the promise that yields back into the owning fiber.

**Allowed boundary.** Bridging Effect into a plain-JS callback contract (e.g. SDK options that
take `(value: string) => void` rather than `(value: string) => Effect<...>`) is the one
legitimate place `Effect.runPromise` belongs. See `WalkthroughJobs`' job body, which builds
plain callbacks (`emit`, `broadcastThreadEvent`, `runJudgment`) with `Effect.runSyncWith` /
`Effect.runPromiseWith` over the run's captured context, and `makeWalkthroughRunContext`
(`services/walkthrough/run-context.ts`), which hands them to the MCP tool handlers. These
are NOT violations — they are the interop boundary with Promise-based handlers. The rule is "no `runPromise` inside an Effect-returning
method" — wrapping a callback that the caller will invoke later is fine.

**Backlog.** [`E-007`](./conventions-backlog.md#e-007). [`E-001`, `E-002`](./conventions-backlog.md#closed) are closed.

<a id="effect-tagged-errors"></a>
### 2.3 Tagged errors live in `domain/errors.ts`

**Rule.** Every domain failure mode declared anywhere in `apps/server/` is a
`Data.TaggedError` defined in `apps/server/src/domain/errors.ts` and exported from a union
type (`GitHubError`, `AiError`, `AppError`). No inline `class FooError extends Data.TaggedError` in
service files; no raw `throw new Error(...)` in Effect-returning methods.

**Why.** Centralizing tagged errors lets callers `Effect.catchTag("FooError", ...)` without
chasing definitions across the tree. Throwing raw Errors converts a typed failure into a defect
(uncaught fiber crash); Effect can recover from `Effect.fail` but only crashes on `Effect.die`.

**Canonical example.** `apps/server/src/domain/errors.ts` declares every error class used by
the server, grouped by domain, and ends with the table that gives each one its HTTP status,
`ApiErrorCode` and message (`httpErrorOf`). Adding a class means adding its row; the table is
typed over the class union, so a missing row doesn't compile. Consumers `catchTag` against the
string tag (e.g. `Effect.catchTag("GitHubAuthError", ...)`).

**Anti-pattern.** Defining a one-off `class LocalError extends Data.TaggedError(...)` inline in
a service file, or returning `Effect.fail(new Error("..."))` (untagged — defeats `catchTag`).
A free-string `code` field that routes match on (the old `ReviewError.code === "NOT_FOUND"`)
is the same smell: use `NotFoundError` / `ForbiddenError`.

**Backlog.** None open; [`E-003`](./conventions-backlog.md#closed) is closed.

<a id="effect-wrap-drizzle"></a>
### 2.4 Wrap Drizzle calls inside Effect.tryPromise

**Rule.** Any `db.select / insert / update / delete` chain that lives inside an
`Effect.gen` body must be wrapped in `Effect.tryPromise({ try, catch })` (or `Effect.try` for
the synchronous `.get()` / `.run()` variants) and the `catch` must map to a tagged error.

**Why.** Drizzle's synchronous `.get()` / `.run()` and asynchronous `.execute()` can throw —
constraint violations, locked tables, schema drift, SQLite IO errors. An unwrapped call inside
`Effect.gen` lets the throw escape as an Effect *defect*, not a *failure*: callers expecting to
`catchTag` on a typed DB error get a fiber crash instead.

**Canonical example.** `apps/server/src/effects/db-try.ts`: `dbTry(label, () => db…)`, which
fails with `DbError` (HTTP 500). A best-effort write says so at the call site
(`Effect.catch` + log), never by the helper inventing a value.

**Anti-pattern.** Calling `db.select(...).get()` directly inside an `Effect.gen` body, or
mapping a Drizzle failure to some other tag (`ValidationError` turned DB faults into HTTP 400s).

**Backlog.** None open; [`E-004`, `E-005`](./conventions-backlog.md#closed) are closed.

---

<a id="module-boundaries"></a>
## 2.5 Module Boundary Rules

The server architecture is documented in [`architecture.md`](./architecture.md). The rules below
are the import-direction guardrails for keeping those modules deep.

<a id="feature-pr-context"></a>
### 2.5.1 Feature modules use PR Context

**Rule.** Walkthrough, Chat, Recap and stack-brief/review feature modules must not import
`GitHubAccounts` or `RepositoryService`. PR-scoped GitHub context flows through
`PrContextService`, and they call `GitHubGateway` only with the `GitHubClient` it hands them for
the repository's owning account: they never mint a client or read repositories around it.

**Why.** Feature modules should express product lifecycle and user workflow logic, not token
lookup, repository ownership, GitHub API calls, or account fallback rules. `PrContextService`
is the narrow seam that hides that platform detail.

**Enforcement.** `bun run check:import-boundaries` (part of `bun run lint`) rejects those
imports from the feature roots it lists.

**Canonical example.** `WalkthroughJobs` depends on `PrContextService` for PR/repo/token/diff
context before starting a walkthrough job.

**Anti-pattern.** A chat or recap route importing `GitHubGateway` to fetch PR metadata or
`GitHubAccounts` to resolve an access token.

<a id="settings-agent-resolution"></a>
### 2.5.2 Settings owns provider selection

**Rule.** Code that needs the effective CLI agent calls `SettingsService.resolveAgent()` or
`SettingsService.resolveRecapAgent()`. AI-provider modules may branch on the returned agent, but
they do not own fallback or validation rules.

**Why.** Agent choice is a settings concern. Keeping it in one service prevents drift between
walkthroughs, chat, recaps, model listing, and session lookup.

<a id="settings-shape"></a>
### 2.5.3 One settings spec; reactions subscribe

**Rule.** A user setting is declared once, in `SETTINGS_SPEC` (`packages/shared/src/settings.ts`),
next to its `UserSettings` field: default, coercion, and what a patch may send. Defaults,
`normalizeSettings`, the settings routes' request schemas and the web's optimistic merge derive from it;
the server adds only the column and its two mapping lines in `services/Settings.ts`. Code that
reacts to a change subscribes to `SettingsService.watch(select)` (or `settingsChanges()`), never
the route that wrote it. Web caches whose answers depend on settings put those settings in their
`createResource` key, so a change misses instead of needing an invalidation hook; panes read
`getSettings()`, which is never null, instead of re-typing defaults.

**Why.** A field used to be hand-added in 5–7 files, and a write that bypassed the route skipped
the scheduler restarts.

<a id="http-edge"></a>
### 2.6 Routes run through `runRoute`; streams through `routes/sse.ts`

**Rule.** A route handler hands its work to `runRoute` (`routes/middleware.ts`) as an Effect.
`runRoute` answers with the value, or with the failure's row of `httpErrorOf` as a typed
`status(code, ApiErrorBody)`, so Eden types every error status a route can answer. A stream
opens through `routes/sse.ts` (`openSse`, `pipeToSse`, `runStream` for a refusal before the
stream starts, which answers the same `ApiErrorBody`). Elysia's own schema and parse refusals
answer it too, as `INVALID` (`requestRefusals`). A router whose paths carry resource ids registers `ownedBy({ id: "pull request" })`
(`routes/ownership.ts`) right after its auth plugin, or `.resolve(asOwner(…))` when its routes
act on GitHub or address an account: that derives `owner`, the account that owns the
repository, which the route acts as whatever host the user has active.

**Why.** One table means a REST route, a stream refusal and the external agent's MCP route
answer the same error the same way. A guard on the router, not each handler, is what keeps a
new route from forgetting the ownership check, or from acting as the wrong account.

**Anti-pattern.** `try { await AppRuntime.runPromise(…) } catch (e) { … }` in a handler, a
hand-written `ctx.set.status = 404` for a condition a domain error already names, or a
hand-rolled `ReadableStream` of `data:` frames.

<a id="services-layout"></a>
### 2.7 A multi-file feature owns a `services/<feature>/` folder

**Rule.** A server feature with more than one file keeps all of them in `services/<feature>/`
(`github/`, `git/`, `walkthrough/`, `chat/`, `jobs/`, `stacks/`, `workspace/`, `blob/`, …). A
service that is one file stays flat in `services/`. A file joining a feature that has no folder
yet creates the folder and moves its siblings in.

**Why.** A change to one feature should touch one folder. Half-moved features (a folder plus
flat `Walkthrough*.ts` / `walkthrough-*.ts` siblings) make every reader check both places.

**Backlog.** [`S-006`](./conventions-backlog.md#s-006).

---

<a id="event-envelopes"></a>
## 3. SSE Event Envelope Conventions

All server-to-client realtime traffic between the Elysia server and the SvelteKit web client
flows over a single SSE stream (`GET /api/events`) and is shaped by the discriminated union
`ServerEventMessage` in `packages/shared/src/events.ts`. This is the canonical source of truth —
anything else is divergence. Inbound (client-to-server) commands are REST endpoints, not stream
messages. Features send through `Realtime` (`apps/server/src/services/Realtime.ts`), which
resolves the receiving account; `Broadcaster` is its transport. See
[`architecture.md`](./architecture.md#realtime--events).

<a id="event-envelope-shape"></a>
### 3.1 Envelope shape is `{ type, data? }`

**Rule.** Every server-to-client message is a discriminated union arm of `ServerEventMessage`
with shape `{ type: string; data?: object | array }`. No flat fields hoisted to the top level;
no alternative discriminator names (`event`, `kind`); no top-level payload fields outside `data`.
Messages with no payload omit `data` entirely rather than passing `data: null`.

**Why.** A single envelope shape lets the frontend dispatcher (`apps/web/src/lib/stores/events.svelte.ts`)
exhaustively switch on `msg.type` with `noUncheckedIndexedAccess`-friendly types. Adding a flat
field means every consumer needs to know which arms carry it.

**Canonical example.** `ServerEventMessage` in `packages/shared/src/events.ts`: 30+ message
arms, all conforming to `{ type, data? }`. Signal-only arms (`PrsSyncStartedEnvelope`) omit
`data`; payload-bearing arms (`PrsSyncFailedEnvelope`) carry a structured `data` object.

**Anti-pattern.** `{ type: "thing-happened", thing: { ... } }` (flat `thing` instead of nested
in `data`). Or `{ event: "thing-happened", data: ... }` (`event` instead of `type`).

**Nested payload note.** Embedding a typed sub-envelope inside `data` is fine when it carries
real meaning. `walkthrough:event` (`WalkthroughEventEnvelope`) wraps a
`WalkthroughStreamEvent` (plus the `prId` / `walkthroughId` / `seq` routing cursor) inside `data`
so the frontend can reuse the walkthrough reducer code path — this is consistent with the rule
(the outer shape is still `{ type, data }`) and is documented in code.

**Backlog.** None — current canon is clean.

<a id="event-envelope-naming"></a>
### 3.2 Type names are `namespace:action`, lowercase, kebab-cased

**Rule.** Message type strings use colon-separated namespace and action segments. Segments are
lowercase ASCII letters with hyphens between words. The namespace is the entity (`prs`, `pr`,
`thread`, `threads`, `walkthrough`, `hunk-scan`, `repos`, `user`, `recap`, `auth`, `stack`, …);
the action is the verb (`updated`, `created`, `sync-started`, `clone-status`, `status-changed`).

**Why.** Easy to grep, easy to scan, no Ambiguity-About-Casing arguments. Bonus: `:` is illegal
in most identifiers, so message types can never accidentally collide with frontend variable
names.

**Canonical example.** Every arm of `ServerEventMessage` follows the rule (`prs:updated`,
`repos:clone-status`, `thread:message:edited`).

**Anti-pattern.** `prsUpdated`, `PRS_UPDATED`, `prs.updated`, or routing on a generic
`message-type` discriminator field that holds free-form strings.

**Backlog.** None — current canon is clean.

<a id="event-payload-semantics"></a>
### 3.3 Pick one payload contract: signal, full-state, delta

**Rule.** Each event message arm declares exactly one of three semantic contracts:

- **Signal** — no `data`. The receipt of the message is the entire signal. Example:
  `prs:sync-started`. Receivers re-fetch authoritative state from the DB.
- **Full-state** — `data` carries the entire new state for some entity or list. Receivers
  replace, they do not merge. Example: `prs:updated` carries `{ host, prs }`, the full
  `PullRequest[]` of the account on `host`.
- **Delta** — `data` carries an instruction the receiver applies to existing state. Example:
  `thread:message` carries `{ threadId, message }` to append. Receivers must be safe to drop
  during disconnect and reconcile via the broadcast contract (CLAUDE.md invariant #8).

The choice is documented at the type definition.

**Why.** Frontend consumers wire reducers to one of three shapes. A message that "kinda" carries
state and "kinda" carries deltas needs custom handler logic per consumer.

**Canonical example.** Three arms of `packages/shared/src/events.ts` illustrating each:
`PrsSyncStartedEnvelope` (signal), `PrsUpdatedEnvelope` (full-state), `ThreadMessageEnvelope`
(delta). Every arm names its contract in its doc comment.

**Anti-pattern.** Mixing — e.g. a `repos:partial-update` message that sometimes carries the
full list and sometimes carries one repo. Receivers can't tell whether to replace or merge.

**Broadcast contract.** All broadcasts are best-effort and lossy. The broadcaster's contract is
documented in code at `apps/server/src/services/Realtime.ts`: commit to SQLite first,
broadcast second; receivers reconcile from the DB on reconnect (the snapshot REST endpoints) and
never derive authoritative display state exclusively from stream messages. This is CLAUDE.md
invariant #8.

<a id="event-scope-targeting"></a>
### 3.4 Every event is addressed to what it concerns

**Rule.** Features send through `Realtime` (`services/Realtime.ts`), never `Broadcaster`
(enforced by `check:import-boundaries`). Every event is addressed to an account,
repository or PR: `toAccount(accountId, msg)`, `toRepo(repoId, msg)` or `toPr(prId, msg)`.
`Realtime` resolves the local user who owns it in one place, and every client of that user
hears it: one stream carries all of the user's accounts. A full-state envelope that describes
one account's list (`prs:updated`, `repos:updated`, `user:updated`) names that account's
`host`, so a client showing another host's list ignores it. There is no send to every client.

**Why.** Scoping is a security boundary, not a perf optimization: several local users can
share one install, and an event about one user's repository must not reach another's client.

**Anti-pattern.** Resolving the owner at the call site (`getAccountIdForRepo` then a send), or
a full-state list envelope without its `host`.

**Backlog.** None — current canon is clean.

---

<a id="stores"></a>
## 4. Web Store Patterns

Svelte 5 stores under `apps/web/src/lib/stores/` are how reactive state crosses component
boundaries. Stores sit below the session layer (`apps/web/src/lib/session/`): the bearer token
is the leaf `session/token.svelte.ts`, and `session/lifecycle.svelte.ts` starts, switches and
ends the signed-in session. No store imports the lifecycle back.

<a id="stores-singleton"></a>
### 4.1 Singleton module + getX/setX exports

**Rule.** A store is a module that declares its reactive state at module-scope (with `$state`)
and exposes it through named `get<Field>()` getters and `set<Field>()` / verb-prefixed action
exports. No factory functions, no classes, no `$effect` at a store's module scope. Action
exports are verb-first (`setSelectedPrId`, `requestSync`); read accessors are noun-first
(`getThreads`, `getActiveTab`). A component that wants a fetch to follow reactive inputs runs
the `$effect` itself and calls the store's action (`ensurePrSizing(prId)`).

When several components need the same effects, the store ships them as a `use<Thing>()` helper
beside it, called during component init so the effects live and die with the component:
`useOpenReview` (`review/open-review.svelte.ts`), `useWalkthroughWatch`
(`walkthrough/watch.svelte.ts`), `useRecapsForRepo` (`recaps/store.svelte.ts`), `useCommands`
(`stores/commands.svelte.ts`), `useAvailableRepos` (`repos/add-repo.svelte.ts`). A helper takes
its reactive inputs as getters (`() => prId`). Shared state stays in the store; a helper keeps
only its own mount's bookkeeping (`useAvailableRepos`' retry count).
When a read means nothing without its ask, the helper runs the ask's `$effect`, returns the
reads as getters, and the store keeps the read private so no reader can skip the ask
(`useMergeEligibility` in `stores/merge-eligibility.svelte.ts`, `useRecapsForRepo`).

**Why.** Svelte 5 runes mean modules ARE the reactive boundary. Wrapping that in a factory
imports a React mental model that the framework doesn't share. The getter/setter split keeps
consumers from importing `$state` proxies directly, which would let components mutate stores
in ways the store doesn't control.

**Canonical example.** `apps/web/src/lib/stores/sync.svelte.ts` declares module-scope
`$state` and exposes only `getLastSyncAt`, `getThreadsSyncing`, `requestSync`, etc.
`apps/web/src/lib/walkthrough/store.svelte.ts` keeps its maps private and exposes getters that
take the PR (`getRatings(prId)`, `getWalkthroughUiState(prId)`); a store never reads an implicit
"active" key, and its reconnect catch-up follows the PRs it watches, not the route. Its pure
folding lives beside it in `reducer.ts` (unit-tested), its user verbs in `actions.ts`.

**Sanctioned exceptions.** Only one review is ever on screen. `pr-view-state.svelte.ts` owns which
PR that is (`openPrView` / `closePrView`, called by `useOpenReview`), and its tab and file
accessors (`getActiveTab()`, `setActiveFilePath()`) act on it.

Two modules own an `$effect.root` because their effects outlive every component:
`stores/sidebar.svelte.ts` persists the panel widths and tracks the viewport width for the life
of the app, and `deep-link/pr-deep-link.svelte.ts`'s `listenForPrDeepLinks()` moves a parked
`revv://` link on when sign-in or onboarding lands (the root layout calls it once and calls
the teardown it returns).

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

**Canonical example.** `apps/web/src/lib/walkthrough/store.svelte.ts` declares
`entries = new SvelteMap<string, WalkthroughEntry>()`; `setEntry`, `deleteEntry` and
`updateEntry` own all writes, and every write stores a new entry object (§4.3).

**Anti-pattern.** A non-reactive plain `Map<prId, ViewState>` plus a separate
`let activeTab = $state(...)` mirror hand-synced in every setter: two sources of truth for the
same state. (`pr-view-state.svelte.ts` keeps one reactive entry per PR instead.)

**Backlog.** None open; [`S-001`, `S-002`](./conventions-backlog.md#closed) are closed.

<a id="stores-reactive-map"></a>
### 4.3 Reactive keyed state is a `SvelteMap` whose values are replaced, not mutated

**Rule.** Per-key reactive state is a `SvelteMap` (or `SvelteSet`) from `svelte/reactivity`.
A write stores a new value: `entries.set(prId, { ...entry, field })`. Never mutate the stored
object and `set` the same reference again.

**Why.** `SvelteMap.set` notifies readers only when the stored reference changes; an in-place
mutation followed by a same-reference `set` lands the data and re-renders nothing (the
"walkthrough empty on reload" bug). `updateEntryInMap` (`walkthrough/entry-equal.ts`) clones,
lets the updater change the clone, and skips the write when nothing changed.

**Canonical example.** `apps/web/src/lib/walkthrough/store.svelte.ts`: the reducer returns a
new entry, `hydrateFromCache` stores the merged snapshot as a new object. The chat modules
(`apps/web/src/lib/chat/*.svelte.ts`) and `createResource` hold their per-PR entries the same way.

**Anti-pattern.** `entry.blocks.push(b); entries.set(prId, entry)`.

**Backlog.** `sync`, `hunk-scan`, `conversation`, `base-conflicts` and `recaps` still hold a
plain `Map` in `$state` and reassign it after each write (`m = new Map(m)`). It still works; move them
when the store is next split.

<a id="stores-request-state"></a>
### 4.4 Request-state triplet uses a shared `RequestState<T>` type

**Rule.** When a store represents the lifecycle of an async load (loading → success | error),
model it as a tagged union `RequestState<T> = { status: 'idle' } | { status: 'loading' } | { status: 'error'; error: string } | { status: 'ok'; data: T }`,
not as parallel boolean flags + nullable error/data fields. The `RequestState<T>` type lives at
`apps/web/src/lib/stores/_types.ts`.

**Why.** Boolean triplet (`isLoading` + `error: string | null` + `data: T | null`) admits
illegal states like `{ isLoading: true, error: "foo", data: T }`. A tagged union forces
exhaustive `switch (state.status)` handling in components and produces narrower types
downstream.

**Canonical example.** Every per-key fetch made through `createResource` (§4.7) is a
`RequestState<T>` per key — `apps/web/src/lib/stores/repo-activity.svelte.ts` hands it straight
to the component, and so does `stacks.svelte.ts`. `conversation.svelte.ts` keeps `RequestState`
inside its own entries.

**Anti-pattern.** Boolean + nullable shape from
`apps/web/src/lib/walkthrough/reducer.ts` (`WalkthroughEntry`): `isStreaming: boolean; streamError: string | null`
plus separate `summary: string | null; blocks: WalkthroughBlock[]`. The four fields form 16
possible combinations; only ~4 are legal.

**Backlog.** None open; [`S-003`](./conventions-backlog.md#closed) is closed.

<a id="stores-event-handlers"></a>
### 4.5 Event handlers in stores are named `on<EventName>`

**Rule.** Functions exported from a store for the SSE router
(`apps/web/src/lib/stores/events.svelte.ts`) to call follow the form `on<EventName>` where
`<EventName>` is the event message `type` with the colon dropped and segments PascalCased
(`thread:created` → `onThreadCreated`; `recap:status-changed` → `onRecapStatusChanged`).
Each takes the envelope's `data` whole, and the store filters on its fields itself (the review
store drops `thread:created` for a PR whose review isn't open). Several stores may handle one
message, each with its own `on<EventName>`; the router lists them all in the message's arm.

A store whose state comes from the stream also owns its catch-up: the re-read that recovers
what a missed envelope carried (invariant 8), usually exported as `onEventsReconnected`. The
router's `CATCH_UP` table is an exhaustive `Record` over the event types: each type names its
catch-up hooks, or says `"none: <why>"`, so a new event type doesn't compile until someone
decides. `ON_RECONNECT` is built from it; keys waiting on a server signal are re-asked by
`refreshAllWaiting()` (§4.7) first. `onEventsOpened` (every connect) and `onWindowForeground`
stay in their own lists, and one 4 s debounce in the router covers reconnect and foreground
re-reads.

**Why.** Reading the dispatcher should make it obvious which store owns which message. The
legacy `*FromWs` suffix style buried the event identity in the middle of the name and pluralized
inconsistently (`updateThreadStatusFromWs` vs the event type `thread:updated`).

**Canonical example.** `apps/web/src/lib/stores/review.svelte.ts` (`onThreadUpdated`,
`onThreadCreated`, `onThreadMessageEdited`) and `walkthrough/store.svelte.ts` / `stacks.svelte.ts`
(both `onWalkthroughEvent`) match the event message types `thread:updated`, `thread:created`,
`thread:message:edited` and `walkthrough:event`. The `dispatch` switch in `events.svelte.ts`
reads as a flat list of these `on*` calls.

**Anti-pattern.** The retired `*FromWs` suffix style — `updateThreadStatusFromWs`,
`addThreadFromWs`, `resolveQuestionFromWs`. No occurrences remain in the codebase.

**Backlog.** None open; [`S-004`](./conventions-backlog.md#closed) is closed (all handlers renamed).

<a id="stores-optimistic"></a>
### 4.6 Client-initiated mutations are optimistic with entity-scoped rollback

**Rule.** A store function that wraps a server mutation flips local state immediately, awaits
the API call, and on error restores the same entity's prior fields. Rollback captures *the
specific fields being mutated on the specific entities involved* — never a list snapshot. If
the calling component branches on the throw (loading spinners, inline errors), the function
rethrows after the toast; otherwise it may swallow.

**Why.** Two reasons. (1) **UI lag.** Waiting for the server round-trip plus the SSE
rebroadcast before reflecting the user's action is the laggy-feel symptom this rule
eliminates — closing a PR, flipping draft state, merging, pinning should feel
instantaneous because the outcome is rarely in doubt. (2) **Concurrency.** A `prs:updated`
arriving during the optimistic window can legitimately add or remove *other* entities.
List-snapshot rollback (`pullRequests = openSnapshot`) would clobber those updates and
re-introduce entities the server has since removed. Restoring only the fields you changed
on the entity you touched is resilient to whatever else arrives over the wire.

**Canonical example.** `apps/web/src/lib/stores/prs.svelte.ts` — `pinPr` and
`unpinPr` capture the single field they mutate (`pinnedPrIds` membership), apply,
and restore on throw. The four owner-only PR mutations (`convertPrToDraft`,
`markPrReadyForReview`, `closePr`, `mergePr`) in the same file follow the same shape
with more fields involved: draft flip uses a single-field local helper; close/merge reuse
the existing `onPrArchived` for the forward open→archived move and `restorePrFromArchive`
for the reverse rollback. Both helpers touch exactly one PR per call so concurrent
`prs:updated` broadcasts that reshuffle the rest of the list survive intact. A removal
that spans entities captures what it removed: `repos.svelte.ts` `deleteRepo` takes back
the repo row plus the restore function `prs.removeRepoPrsLocally` returns for that repo's
PRs and pins. The review store's thread mutations restore only the thread or message they
touched.

**Anti-pattern.** Snapshotting whole lists (`const prev = threads`) and reassigning them on
error: any concurrent SSE broadcast between snapshot and rollback is silently dropped.

<a id="stores-resource"></a>
### 4.7 Per-key fetches go through `createResource`

**Rule.** A store that fetches something per key (a PR, a repo, a head SHA) does it through
`createResource` from `apps/web/src/lib/stores/resource.ts`, not a hand-rolled in-flight Map,
freshness timestamp, generation counter or retry loop. The key identifies every input the answer
depends on — `(prId, headSha, agent, model)` for the sizing preview — so a settings change
needs no cross-store invalidation: the next read simply misses. What the fetcher needs is its
argument, which the resource remembers per key (`argOf`, `refreshAll(match)`,
`refreshWaiting(match)`), so nothing is packed into a key string and parsed back out. A server
answer that is still `pending` waits for the server's completion envelope (`waitForSignalMs`:
the store's handler calls `refresh`, `refreshWaiting`, `put` or `giveUp`); such a resource
registers itself, and the router's `refreshAllWaiting()` re-asks its waiting keys after a
reconnect. A pending answer the server never announces is re-asked on the bounded
`retryDelaysMs` schedule.
A client poll is the fallback, not the design: when the server knows a computation finished,
it says so.

**Why.** Ten stores each had their own de-dupe, freshness window and backoff, with drifted
semantics (some re-asked while a retry was scheduled, some cached errors forever). One
primitive gives one answer to "is this in flight, fresh, retrying, superseded or reset".

**Canonical example.** `apps/web/src/lib/stores/merge-eligibility.svelte.ts` (versioned by the
question, the settled answer pushed as `pr:merge-eligibility`), `repo-activity.svelte.ts`
(waits for `repo-activity:settled`, keeps data on error), `walkthrough/sizing.svelte.ts` (key
includes the routing settings, waits for `diff:cached`).
`stacks.svelte.ts` keeps its data in the resource; `hunk-scan/store.svelte.ts` keeps its own
entries (the stream writes them too) and uses a resource only to schedule asks.

Ordering that isn't a per-key fetch keeps its own guard, with a comment saying why:
`conversation.svelte.ts`'s `writeGeneration` (a read racing a write), `pr-deep-link`'s
`requestVersion` (a multi-step workflow), `repos.svelte.ts`'s load sequence (a pushed list and a
fetched one, each awaiting avatar decoding), the archive's fetch token (a paged feed reloaded by
a filter).

**Anti-pattern.** A module-level `const inFlight = new Map<string, Promise<void>>()` next to a
`loadedAt` timestamp.

<a id="stores-session-reset"></a>
### 4.8 Account-scoped stores export `reset()`, called by the session lifecycle

**Rule.** A store that holds data of the signed-in account exports `reset()`, which drops that
data and stops anything still writing it (streams, timers, retries). `resetAccountStores()` in
`apps/web/src/lib/session/lifecycle.svelte.ts` calls every one of them, in one list, on account
switch, sign-out and account removal. Stores never import the auth store to tear themselves down.

**Why.** Three hand-written teardown lists in `auth.svelte.ts` had drifted apart, and most
stores were on none of them, so an account switch left the previous account's chat, walkthrough
and recap streams writing into the new session.

**Canonical example.** `apps/web/src/lib/chat/turn.svelte.ts` `reset()` aborts in-flight turns,
then resets every chat module (timeline, proposed commits, session context, queue, suggestions);
`stacks.svelte.ts` `reset()` resets its resource and debounce timers.

<a id="stores-transport"></a>
### 4.9 JSON calls go through `call(eden, fallback)`; streams through `sseError`

**Rule.** Every JSON request goes through the Eden client in `apps/web/src/lib/api/client.ts`,
awaited with `call(request, fallback)` (`api/errors.ts`): it returns the success body or throws
an `ApiError { status, code, body, message }`, the message being the server's wording or the
fallback with the status. `code` is one of the shared `API_ERROR_CODES`, or null. Its types come
from Eden inference (`EdenData<…>` in `api/wire.ts`) or `@revv/shared`, never a hand-written copy
of the server's response. Branch on a refusal by its `code`, not its status. A stream
(`streamSse({ refused, … })`, `api/sse-stream.ts`) refused before it opens throws the same
`ApiError`, `refused` being its fallback; any stream failure reads through `sseError` /
`sseErrorMessage`. Raw `fetch` is for bytes (`ImageDiffViewer`'s blobs, worded with an
`ApiError` too) and SSE streams only.

**Why.** The client sets `parseDate: false`, so a date is the ISO string the shared types and the
SSE stream both carry; a hand-typed shape or an `as` cast silently drifts from the route, and
seven copies of "read `error`, else `message`, else the status" had drifted already. Eden
answers a refusal with `{ data: null, error }` and only throws on the network, so a store that
`try`/`catch`es a bare Eden call treats every 4xx/5xx as success: refused pins stayed pinned
and refused syncs left their spinners on.

**Anti-pattern.** `try { await api.api.x.post() } catch { rollback() }`, `(await res.json()) as
Foo`, `error.value as { error?: string }`, or a store declaring the interface of a route's
response.

---

<a id="ui-motion"></a>
## 5. UI & Motion Conventions

The motion rules in CLAUDE.md are the authoritative summary. This section restates them with
examples and records the decision on the onboarding's former parallel motion scale (see §5.2).

<a id="motion-tokens"></a>
### 5.1 Use canonical motion tokens, never hand-typed values

**Rule.** All `transition` and `animation` durations come from the `@theme` block in
`apps/web/src/app.css` (`src/lib/motion/tokens.ts` is generated from it):

- `--duration-instant: 80ms` — hover, focus rings, micro-state
- `--duration-snap: 120ms` — chevrons, badges, small surfaces
- `--duration-quick: 160ms` — default UI motion
- `--duration-smooth: 220ms` — panels, sidebars, larger reveals
- `--duration-slow: 320ms` — dialogs, sheets, big surfaces
- `--duration-page: 480ms` — route / shared-element morphs
- `--duration-pulse: 1400ms` — decorative infinite loops
- *(ceremonial tier — see §5.2)*

Easings come from:

- `--ease-soft: cubic-bezier(0.4, 0, 0.2, 1)` — exits, bidirectional state
- `--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1)` — enter / appearance
- `--ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1)` — enter without the snap, for motion the eye follows end to end (a hover lift, cards being dealt)
- `--ease-standard: cubic-bezier(0.22, 0.61, 0.36, 1)` — walkthrough chapters
- `--ease-anticipate: cubic-bezier(0.68, -0.55, 0.27, 1.55)` — playful overshoot, reserved for delight moments

Entrances, exits and interaction motion go through `$lib/motion` (GSAP). A CSS `transition`
is fine for a state change the browser can crossfade (hover colours, a handle widening, a
panel sliding to a new resting place) as long as it uses these tokens. Reference them in CSS as
`var(--duration-quick) var(--ease-out-expo)` or via Tailwind utilities (`duration-quick`,
`ease-out-expo`). No literal `cubic-bezier(...)`, no `220ms`/`300ms`/`0.55s` magic numbers, no
`ease-in` shorthand.

**Why.** The motion language is a shipped product surface. Bespoke easings drift away from the
brand voice; bespoke durations make screens feel uneven. Canonical tokens also collapse
correctly under `prefers-reduced-motion` (see CLAUDE.md).

**Canonical example.** The sidebar resize handle in `apps/web/src/lib/components/layout/AppShell.svelte`
(`.resize-handle::after`) uses
`transition: width var(--duration-snap) var(--ease-soft), left var(--duration-snap) var(--ease-soft), background-color var(--duration-snap) var(--ease-soft)`.

**Anti-pattern.** IssueCard's old entrance (closed as M-029):
`animation: issue-card-enter 0.55s cubic-bezier(0.22, 0.61, 0.36, 1) both;` — both the
duration and the easing are literals. The easing is byte-identical to `--ease-standard`; the
duration has no canonical equivalent.

**Backlog.** None open; [`M-029`](./conventions-backlog.md#closed) (hand-rolled `@keyframes`) is closed.

<a id="motion-ceremonial"></a>
### 5.2 Ceremonial motion has its own tier — but in the main scale

**Rule.** Onboarding's deliberately slow, theatrical motion uses three ceremonial tokens added
to the SAME `@theme` block in `app.css`:

- `--duration-ceremonial-quick: 280ms`
- `--duration-ceremonial-medium: 480ms`
- `--duration-ceremonial-slow: 720ms`

The eases reuse the canonical tokens (`--ease-out-expo`, `--ease-standard`). The onboarding's
old parallel `--ob-dur-*` / `--ob-ease*` scale is retired; the `--ob-*` variables left in
`OnboardingShell.svelte` are its colour palette.

**Why.** A parallel scale was tried and failed: `--ob-*` existed, but most onboarding components
hand-typed unrelated values (`800ms`, `1200ms`, `760ms`, `540ms`, `600ms`) that don't reference
the scale at all. Folding ceremonial into the main scale gives a single source of truth and
removes the temptation to mix-and-match.

**Decision rationale.** Considered: (a) keep `--ob-*` as a documented sibling scale and treat
non-conforming onboarding values as violations; (b) fold into the main scale. Picked (b)
because the parallel scale has not, in practice, prevented drift and adds cognitive load for
no observable benefit. The eases are already shared; only the durations needed addition.

**Use outside onboarding.** Ceremonial durations are valid anywhere the motion is genuinely
slow and intentional — empty-state illustrations, success-celebration moments, hero reveals.
They are not a fallback for "I want this longer" — that's almost always `--duration-smooth`.

**Canonical example.** `apps/web/src/lib/components/onboarding/OnboardingShell.svelte` reveals
each step's title with `gsapEnter` at `tokens.ceremonialSlow`; in CSS,
`review/spec-panel/RatingsFooter.svelte` runs its bump at
`var(--duration-ceremonial-medium) var(--ease-out-expo)`.

**Anti-pattern.** Hand-typed durations that match no token, such as onboarding's old
`animation: fin-in 1200ms cubic-bezier(...) 600ms backwards` in `StepDone.svelte` (since moved to
`gsapEnter` with `tokens.ceremonialSlow`).

**Backlog.** None open; [`M-008` through `M-014`](./conventions-backlog.md#closed) are closed.

<a id="motion-icon-only"></a>
### 5.3 Iconography

**No emoji.** The "always use icons, never emojis" rule lives in CLAUDE.md and is fully
honored — zero violations. No emoji glyphs in rendered UI, toasts, or component text.

**One icon system: `phosphor-svelte`.** Import deep
(`phosphor-svelte/lib/<Icon>`), never from the package root, and **never under an
alias**. The import name is the phosphor icon name. A Lucide-era alias
(`import Loader2 from ".../Spinner"`) hides which glyph actually ships, and cost us
six wrong icons — a bare `Octagon` for "blocker", an open-PR glyph for "closed", a
`CalendarCheck` for "scheduled", and a sidebar toggle whose two `{#if}` branches
resolved to the same icon, so the button never changed.

**Defaults come from one place.** `routes/+layout.svelte` wraps the app in
phosphor's `<IconContext>` and sets `weight: "regular"` and `aria-hidden: "true"`.
Call sites state only what differs. Props beat context, so both stay overridable.

- **`aria-hidden`.** phosphor stamps `role="img"` on every `<svg>`, and a `role=img`
  with no accessible name is an unlabelled image (WCAG 1.1.1). Icons are decorative —
  the adjacent label or the button's `aria-label` carries the meaning. An icon that
  IS the only signal opts back in with `aria-hidden="false"` plus an `aria-label`.
- **`weight` is information, not decoration.** `regular` is the default. `weight="fill"`
  means one of exactly two things:
  1. **State** — the on / active / selected half of a toggle. Prefer a dynamic
     expression on one glyph (`weight={open ? "fill" : "regular"}`) over swapping
     glyphs in an `{#if}`.
  2. **Severity** — a status marker where solidity itself is the signal.

  `weight="bold"` holds a stroke glyph's weight where `regular` thins out, in
  one of two places:
  1. **Small chrome** — a glyph drawn at 15px or less: disclosure carets
     (`components/shared/DisclosureCaret.svelte`), a close ×, an inline action
     icon beside its label.
  2. **An outline mark in a set of `fill` marks** — a status glyph with no
     filled form that sits beside filled ones, so every mark in the set reads
     equally heavy: the pending `CircleDashed` beside filled pass/fail circles
     (`CiGlyph`), `GitDiff` beside a filled approval (`VerdictGlyph`), `GitMerge`
     beside filled layer states (`StackLayerGlyph`).

  `thin`, `light`, and `duotone` are not used.

**The severity ramp.** Solidity descends with severity, so the most severe mark is
always the heaviest on screen. Applies to the issues panel, the ratings panel, the
approve dialog, and toasts.

| Level | Glyph | Weight |
| --- | --- | --- |
| critical / blocker / error | `WarningOctagon` | `fill` |
| warning / concern | `Warning` | `fill` |
| failed check | `XCircle` | `fill` |
| success / passed check | `CheckCircle` / `Check` | `fill` / `regular` |
| info | `Info` / `Circle` | `regular` |

**Inline SVG** is for brand and octicon-style marks only (`components/icons/*`, the
`@pierre/trees` file-type sprite in `utils/file-icon.ts`, `ContinueArrow`). If a
phosphor equivalent exists, use it — a hand-rolled 24-grid, 1.5–2px-stroke glyph
next to phosphor's 256-grid set reads as two different icon sets. Imperative DOM
callers that can't mount a component use `utils/phosphor-markup.ts`, which carries
phosphor's own path data.

**Backlog.** [`M-030`](./conventions-backlog.md#m-030).

### 5.4 Rendered markdown goes through `<Markdown>`

Every surface that renders markdown uses `lib/components/markdown/Markdown.svelte`:
`<Markdown source trust density? fade? class? />`. Nothing else calls the renderer or
`{@html}`s markdown. The component owns what each sink used to have to remember:

- **Trust.** `trust="agent"` is text Revv's own agents wrote (walkthrough, ratings, chat
  replies, plans, thoughts): its HTML keeps `class`/`style` and `prlens` fences become
  diagrams. `trust="external"` is anyone else's (GitHub bodies, comments, reviews and
  synced thread messages, CI summaries, the user's own chat text): `style` keeps only
  colors, `class` only the renderer's own names, and `prlens` fences stay code. Pick by
  who wrote the text, not by where it shows.
- **Prose.** The root carries `prose prose-sm`, plus `prose-dense` (13px/1.55) for
  `density="dense"` side panels and threads. Markdown styling is owned by the themed
  `@tailwindcss/typography` layer in `apps/web/src/lib/styles/prose.css`, whose
  `--tw-prose-*` slots map to `--color-*` tokens so both themes work with no `prose-invert`.
  Components **must not** re-declare element-level markdown CSS
  (`:global(p|code|strong|ul|ol|li|pre|blockquote|a)`); express per-panel deviations as
  `--tw-prose-*` / container overrides on a `class` you pass, styled from a scoped
  ancestor (`.card :global(.card-body) { … }`).
- **Code highlighting.** The first fenced block with a language loads Shiki; every
  `<Markdown>` re-renders when it is ready.
- **Links** open in the browser, never in the app's webview.
- **Decorations** (`lib/markdown/decorate.ts`): post-processing over rendered markdown
  (diagrams, chat file references and mentions, stack citation chips) is a
  `decorationAction`, which re-applies after every content or value change. Apply one
  to a `<Markdown>` with `{@attach fromAction(action, () => value)}` or to an ancestor
  with `use:`.

A surface that deliberately is *not* markdown (e.g. an inline-only sanitized display
string like the recap lede) stays outside a `.prose` ancestor.

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
demonstrates the pattern. `GuidedWalkthrough.svelte`'s `interface Props { prId: string }` with
`let { prId }: Props = $props();` is representative.

**Backlog.** None — already-canon.

<a id="components-events"></a>
### 6.2 Event handlers use `onclick={fn}` property-style

**Rule.** Use Svelte-5-style lowercase property bindings (`onclick={handler}`,
`onsubmit={handleSubmit}`). No `on:click` directives (Svelte 4); no `handleClick` naming
convention for inline arrows — bind a named function or inline an arrow directly.

**Why.** Already universal; `on:click` directives are 0 occurrences in the audited components.
Lowercase-property bindings interop with native DOM event names without a custom dispatcher
layer.

**Canonical example.** `GuidedWalkthrough.svelte` binds named functions (`onclick={handleResume}`
on its Retry buttons), and `review/chrome/WalkthroughActionBar.svelte` hands
`onRegenerate={handleRegenerate}` to its action pills.

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
