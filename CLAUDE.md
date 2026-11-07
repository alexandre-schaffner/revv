# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Revv** is an AI-powered code review desktop application. It's a Tauri v2 desktop app with a SvelteKit frontend and a local Bun/Elysia API server that syncs GitHub pull requests and enables AI-assisted review workflows.

Stack: Bun + TypeScript monorepo (Turborepo), Svelte 5, Elysia, Drizzle ORM on SQLite, Tauri v2 (Rust).

## Commands

```bash
# Setup
bun install              # Install all workspace deps (no .env needed: see Environment)

# Development (dev channel: server @ 45679, apps/server/revv-dev.db)
make dev                 # Grafana stack, collector, web @ 5173 and server; no desktop shell
make dev-desktop         # The same plus the Tauri dev app
make dev-server          # Elysia API only

# Quality (see Operational Reminders)
bun run typecheck && bun run lint && bun run knip && bun run build
bun run test             # Every package's tests, against a sandboxed DB and git config

# Build & Distribution
make build               # Build all packages
make dist                # Build Revv.app (what the source installer copies)
make dmg                 # Build the DMG installer

# Database
cd apps/server && bunx drizzle-kit generate   # Generate migration from schema changes (needs a TTY)

# Cleanup
make clean               # Remove build artifacts
make reset-db            # Delete the dev DB (revv-dev.db) and ~/.revv/settings.json
```

## Architecture

### Monorepo Layout

- `apps/web` — SvelteKit frontend rendered by the Tauri desktop shell (from the Vite dev server at `localhost:5173` in dev, from `../web/build` in prod). Revv is a desktop-only app; the frontend is not a standalone browser app.
- `apps/server` — Elysia HTTP + SSE server (port 45678; the dev channel uses 45679)
- `apps/desktop` — Tauri v2 shell: spawns and supervises the bundled server, tray, deep links, updater
- `apps/collector` — dev-only OpenTelemetry receiver and query API (port 45680) behind the Grafana dashboards
- `packages/shared` — Shared types, constants (`API_PORT`, `DEV_API_PORT`, `COLLECTOR_PORT`), SSE event schemas, and the desktop contract (`desktop-contract.ts`)

`packages/shared` is the source of truth for cross-app types. Import from `@revv/shared`.

### Server (`apps/server`)

- **Effect system** throughout: services use `Effect.gen`, `Context.Service`, and `Layer` for DI and structured error handling. Don't bypass Effect when modifying services.
- **Services**: `GitHubGateway` (`services/github/`, every GitHub call, made with a host-bound `GitHubClient`), `GitHubAccounts` (account tokens, re-auth, identity), `PrMirror` (the one writer of GitHub's view of a PR), `RepositoryService`, `PullRequestService`, `PollScheduler`, `Broadcaster`, `Settings`
- **Git**: only `services/git/` runs git, through one runner that never runs the user's hooks (the clone is often the user's own repo); commits Revv writes for the user's branches are signed per the user's own config, non-interactively (a signer that would prompt fails with its error), and internal ones are unsigned. One push per remote branch (`BranchPushLock`); never `git worktree prune`, never move a branch the user owns. Every folder Revv uses in a clone is keyed on the repository row (`services/clone/layout.ts`); a folder belongs to one row. The chat agent's per-PR worktree belongs to `PrWorkspace` (`services/workspace/`), and anything that touches it (including the prune when the PR closes) takes the PR's claim; the chat turn is `ChatTurnService` (`services/chat/`).
- **Auth**: GitHub's device-code flow (`routes/device-auth.ts`): no client secret and no OAuth callback URL. `GitHubAccounts` owns users, accounts (each row records the OAuth client its token was issued to), tokens (OS keychain via `SecretStore`) and sessions: it mints a 30-day bearer session token that each day of use extends, and `withAuth`/`withAccount` (`routes/middleware.ts`) resolve it. The SSE stream takes the same token as `?token=`. better-auth is no longer used at runtime; its `user`/`session`/`account` tables remain.
- **Database**: Drizzle ORM on SQLite: `~/Library/Application Support/Revv/revv.db` in prod, `apps/server/revv-dev.db` under `make dev`. Schema in `src/db/schema/` (one file per table). Migrations live in `src/db/migrations` and are applied on startup (below).
- **Realtime (SSE)**: Clients open a single `GET /api/events?token=…` stream. Features send through `Realtime`, which resolves the owning account; `Broadcaster` is its transport. Inbound commands use REST endpoints.
- **Layout**: a feature with more than one file keeps all of them in `services/<feature>/` (`github/`, `git/`, `walkthrough/`, `chat/`, `jobs/`, `stacks/`, …); a single-file service stays flat in `services/`. Flat files that belong to a feature folder are tracked in `docs/conventions-backlog.md`.

#### Database migrations

The project uses **Drizzle's code-first migration workflow**.

**How it works:**
1. **Schema is the source of truth.** All tables, indexes, and relations are defined in TypeScript under `apps/server/src/db/schema/`.
2. **Generate a migration** after changing the schema by running `cd apps/server && bunx drizzle-kit generate`. This compares the current schema against the database state and writes a new `.sql` file + a `meta/` snapshot into `src/db/migrations/`.
3. **Migrations are applied automatically on startup.** `createDb` (`src/db/index.ts`) first reconciles Drizzle's ledger with the schema (`src/db/journal.ts`), then calls `migrate()` from `drizzle-orm/bun-sqlite/migrator` on the `src/db/migrations` folder. You do **not** need to run `drizzle-kit migrate` or `drizzle-kit push` manually.
4. **Migration state is tracked** in a `__drizzle_migrations` table inside the database. Already-applied migrations are skipped on subsequent starts.

**Expected agent workflow when schema changes are needed:**
1. Edit the Drizzle schema files in `apps/server/src/db/schema/`.
2. Generate the migration: `cd apps/server && bunx drizzle-kit generate`.
3. Review the generated `.sql` file in `apps/server/src/db/migrations/` for correctness.
4. Run `bun run check:migrations`; it replays the upgrade against a populated database. Restart the dev server (`make dev-server` or `make dev`) only with the dev env, never against the prod DB.
5. If the generated migration is wrong (e.g., destructive defaults, wrong column types), **edit the generated `.sql` file before restarting** rather than trying to fix it after it has been applied.

**Do not** run `drizzle-kit push` against the local SQLite file — the app relies on the migration-file workflow for reproducible schema evolution.

**Shipped migrations are append-only.** Nightly builds ship every push to `main`, so a migration on `main` has already run on users' databases. Drizzle alone only applies journal entries whose `when` is newer than the last one a database recorded. `reconcileJournal` (`src/db/journal.ts`) is the safety net that runs first on every boot: it applies unrecorded migrations below that frontier and restores schema objects a migration created that went missing. It cannot see an *edited* migration (same `when`, already recorded), which is skipped on every existing install. When rebasing onto a `main` that gained migrations, renumber *your* migration after theirs with a larger `when`; never touch theirs. Adding a `NOT NULL` column needs a `DEFAULT`. `bun run check:migrations` (part of `bun run lint`) enforces all of this, and replays an upgrade from every earlier migration against a populated database. Never boot the server against a real database to "try" a migration: without the `make dev` env it opens the prod DB.

### Web (`apps/web`)

- **Svelte 5 runes** (`$state`, `$derived`, `$effect`) — not Svelte 4 stores/writables.
- **Stores** (in `src/lib/stores/`): `auth.svelte.ts`, `prs.svelte.ts`, `events.svelte.ts`, `settings.svelte.ts`. These expose getter/setter functions, not subscribables. The selected PR and repo come from the URL (`route.svelte.ts`), never a mirrored store field. Workflows that span stores (opening a PR, pulling a moved head, submitting a review) live above them in `src/lib/review/`; the review page names its PR and `useOpenReview` asks for everything the page loads.
- **Session** (in `src/lib/session/`): `token.svelte.ts` is the leaf bearer token every transport reads; `held-sessions.ts` keeps every account's session token on this machine, which is all a signed-out window's account picker can offer (the server answers nothing unauthenticated); `lifecycle.svelte.ts` starts, switches and ends the signed-in session (SSE connect, first reads, every store's `reset()`). The client never polls GitHub on a timer: the server's PollScheduler is the only sync cadence.
- **Chat**: state lives in `src/lib/chat/` (`timeline`, `proposed`, `session`, `queue`, and `turn`, which sends turns and owns the PR-level actions), its UI in `components/chat/`. Tool-call cards and peeks shared by chat, walkthrough and recaps are in `components/agent-activity/` (with the token gauge the bottom bar shows).
- **Feature folders**: a feature's state, pure logic and API calls live together in `src/lib/<feature>/` (`chat/`, `walkthrough/`, `hunk-scan/`, `recaps/`, `agent-setup/`, `repos/`, `conversation/`, `stacks/`, `pierre/`, `markdown/`, …); a helper only one component folder uses sits in that `components/<feature>/` folder. `src/lib/utils/` keeps only helpers several features share.
- **API client**: Eden (Elysia type-safe client) — import from `@revv/server` types.
- **Deep links**: `revv://` links open a PR (`deep-link/pr-deep-link.svelte.ts`, which also listens through `tauri-plugin-deep-link` from `routes/+layout.svelte`). Sign-in is GitHub's device flow, with no redirect back into the app.
- **Component library**: shadcn-svelte + Tailwind CSS v4.

### Desktop (`apps/desktop`)

- Tauri v2. Frontend served from `../web/build`; dev loads `http://localhost:5173` with `tauri.dev.conf.json` merged over `tauri.conf.json` (it replaces arrays such as `windows` whole).
- `server.rs` spawns the bundled `revv-server`, polls `/api/health`, restarts it up to 3 times, and passes its own pid (`REVV_DESKTOP_PID`) so the server exits with it. `server_config.rs` reads `desktop-server.json`. `lib.rs` wires the tray (closing the window hides to it), the `artifact://` scheme walkthrough artifacts render through, and the plugins: single-instance, deep-link (`revv://`), dialog, opener, autostart, updater, process, and the MCP webview bridge in debug builds.
- The CSP allows the API on `localhost:45678` and `:45679`, and `frame-src artifact:`; the dev CSP adds the collector. `bun run check:desktop-contract` holds every port, path and name that crosses into Rust, JSON, shell or Nix to `packages/shared`.

## TypeScript Config

All packages extend `tsconfig.base.json` which enables `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`. These are enforced — don't suppress errors with `as` casts unless unavoidable.

## UI Conventions

**Always use icons, never emojis.** For any glyph in the UI — buttons, fallback avatars, placeholders, status indicators, empty states, inline hints — use a phosphor-svelte icon component or an inline SVG for brand/octicon-style marks. Do not use emoji characters (🎉, ✅, ❌, 👤, etc.) in rendered UI, toast messages, or component text. `phosphor-svelte` is the standard icon library; only inline SVG when no phosphor equivalent fits.

**Motion: token CSS transitions, GSAP via `$lib/motion` for everything else.** A CSS `transition:` rule is fine when its durations and easings are the motion tokens (conventions §5.1). Every other animation goes through `$lib/motion` (`apps/web/src/lib/motion/`): use the actions, presets, and Svelte transitions from there (`gsapPress`, `bitsAnim`, `dialogSpringIn`, `gsapFade`, `gsapFadeY`, `gsapSlide`, …) instead of Svelte built-in transitions (`transition:fade`, `transition:slide`, …) or hand-rolled `@keyframes`. The motion tokens (`--duration-*`, `--ease-*`, `--stagger-*`) live in `app.css`' `@theme` block; `$lib/motion/tokens.ts` is generated from them (`bun run gen:motion-tokens`, checked by `bun run lint`). Never import `gsap` from the package directly; only `$lib/motion/gsap.ts` may (`check:import-boundaries` enforces it).

**Reduced-motion contract.** `prefersReducedMotion()` from `$lib/motion` is the single arbiter. Every action, preset call site, and motion `$effect` reads through it. The defensive global `@media (prefers-reduced-motion: reduce)` block in `app.css` covers the CSS animations that intentionally stayed off GSAP (loader spinner, text shimmer, indeterminate progress, dotmatrix, per-character markdown fade) — see `motion/README.md` for the list.

## Code Conventions

Canonical patterns live in [`docs/conventions.md`](docs/conventions.md). Existing violations are tracked in [`docs/conventions-backlog.md`](docs/conventions-backlog.md). The rules below are the headline summary; the doc is the authority.

- **Effect services.** A service tag `X` (or `XService`) pairs with its Layer `XLive` (`XServiceLive`). No `Effect.runPromise` inside an Effect-returning method — schedule with `Effect.forkChild` / `Effect.sleep` / `Effect.callback`. Tagged errors live in `apps/server/src/domain/errors.ts`, never inline. Drizzle calls inside `Effect.gen` are wrapped in `Effect.try*` mapping to a tagged DB error. ([§2](docs/conventions.md#effect-services))
- **SSE event envelopes.** Shape is `{ type, data? }`; type strings are `namespace:action` colon-style; payload contract is one of signal / full-state / delta and documented at the type definition. Features send through `Realtime` (`services/Realtime.ts`); `Broadcaster` is transport only. Data-bearing envelopes are account-scoped (`Realtime.toAccount`, or `toRepo`/`toPr`, which resolve the owning account); `Realtime.toAll` is reserved for server-global sync signals. Source of truth: `packages/shared/src/events.ts`. ([§3](docs/conventions.md#event-envelopes))
- **Web stores.** Singleton module + `getX/setX` exports; per-PR state is `Map<prId, Entry>` with shared `setEntry/deleteEntry/updateEntry` helpers; every Map/Set write is followed by reassignment for reactivity; request-state is a tagged `RequestState<T>` union, not parallel boolean+nullable triples; event handlers are named `on<EventName>` matching the message type and take the envelope's `data` whole; per-key fetches go through `createResource` (`stores/resource.ts`); account-scoped stores export `reset()`, called from `session/lifecycle.svelte.ts`; JSON calls go through Eden (`api/client.ts`, no hand-typed response shapes), awaited with `call(request, fallback)` (`api/errors.ts`), which throws a refusal as an `ApiError`. ([§4](docs/conventions.md#stores))
- **Motion.** All durations and easings come from the `@theme` block in `app.css` (`--duration-snap/quick/smooth`, `--ease-soft/out-expo/standard`). A ceremonial tier (`--duration-ceremonial-quick/medium/slow`) is reserved for onboarding-style theatrical motion. No hand-typed `cubic-bezier(...)`, no `220ms`/`0.55s` literals. ([§5.1–5.2](docs/conventions.md#motion-tokens))
- **Svelte components.** Props declared as `interface Props` + `$props()`. Event handlers as `onclick={fn}` (lowercase property style), not `on:click`. ([§6](docs/conventions.md#components))

Proposing a new convention: open a PR editing `docs/conventions.md`; no RFC ceremony. New violations land with a matching backlog row.

## Environment

Nothing is required to develop: sign-in is GitHub's device flow, the github.com client ids are bundled (`apps/server/src/config.ts`), and tokens live in the OS keychain; when it is unavailable they fall back to an encrypted file keyed by `secret-store.key`, generated in the app-data dir on first use (`BETTER_AUTH_SECRET` overrides it, a name kept so existing fallback stores stay readable). `config.ts` is the only reader of Revv's env vars; `.env.example` lists the optional ones. A GitHub Enterprise host needs its own OAuth/App client id, entered during onboarding (or `GITHUB_CLIENT_ID`).

## Product Direction

`docs/prds/` holds the historical roadmap: 6 PRDs plus an index of emergent features. Its README records what shipped, where it diverged from the plan, and what remains. Read it before implementing new features to understand intended design; where it disagrees with this file, this file wins.

## Agent Subsystem Invariants

These rules govern every AI-agent pipeline in Revv (walkthrough generation today, post-review
agent tomorrow). Any change that violates them is wrong by construction — push back, don't
"just make it work."

### The Four Actors

- **SQLite (journal).** Single source of truth for all state affecting correctness or
  resumability. On crash, the system reconstructs itself from here and nothing else.
- **Elysia (orchestrator + lifecycle owner).** Schedules jobs, enforces concurrency, runs
  resume-on-boot, spawns agents, owns lifecycle writes (`status`, `last_completed_phase`,
  `resumeAttempts`, watermarks). Holds ephemeral coordination caches that are reconstructible.
- **MCP server (agent write gateway).** The only path by which an agent's content reaches
  SQLite. Each tool is an atomic, idempotent upsert on a deterministic key, and each tool is
  bound to a specific phase. Agents reach it over HTTP (the `/mcp/*` routes, authenticated
  by a per-run bearer token); **tool handler implementations are in-process code shared by
  every agent and every route that serves them.**
- **Agent (stateless-across-runs worker).** An ACP (Agent Client Protocol) agent subprocess —
  Claude Code, Codex, opencode or Cursor, picked in settings — driven over stdio by Elysia.
  In-memory reasoning state is never authoritative. Between runs, the agent reconstructs its
  context from DB via an MCP read tool.

### Invariants

1. **SQLite is authoritative.** In-memory state is a reconstructible cache. Correctness must
   survive `kill -9` at any instruction.
2. **Agent content writes go through MCP, only.** Orchestrator lifecycle writes stay in
   Elysia and must not be routed through MCP. Several routes may serve the same handlers
   (chat-edit, external agents); the *handlers* are shared, never copied per route.

   **Carve-out: orchestrator-computed judgments.** A closed, enumerated set of fields is
   computed by the orchestrator (today: from TypeSafe System One / Jev) and written by Elysia
   directly into content tables: `walkthroughs.risk_level` / `.risk_confidence`,
   `hunk_scan_rows.signals` (the first pass, below), and the `walkthrough_leads` selection
   (which flagged hunks a run's agent is handed, recorded once at job start; its verdict
   columns are written only by `resolve_lead`). These are judgments over a
   closed set, not prose. **All prose, citations, blocks, issues, steps, and
   sentiment remain MCP-only.** Growing this list means editing this rule — it is not a
   general licence for Elysia to write content.

   `walkthrough_issues.advisory_score` / `.advisory_scored_at` (and the severity relabel) are
   the same kind of judgment but need no carve-out: `flag_issue` writes the row with them
   null and schedules the judgment that fills them in (`ai/jev/issue-relevance-persistence.ts`,
   see invariant 4), so they stay on the tool handler's path. A judgment a tool handler can
   own belongs to the tool handler — the carve-out is only for judgments the orchestrator has
   to make outside any tool call.
3. **Each MCP tool call is one atomic idempotent write** keyed on a deterministic identity.
   Replays are no-ops.
4. **Content generation is a strict 4-phase pipeline: A → B → C → D.** Phases complete in
   order. Schema enforces it; tool surface enforces it; orchestrator enforces it.
   Before Phase A, the agent gets the **first pass**: one Jev call per substantive hunk
   (long hunks in windows, no cap) scores nine smells into `hunk_scan_rows`, and the flagged
   hunks reach the agent as prompt leads to verify — never as findings, and never through a
   tool. The leads a run is handed (capped, with a few slots reserved per smell) are recorded
   in `walkthrough_leads` under ids `L1…Ln` before the prompt goes out, so a resume sees the
   same set; the agent answers each with `resolve_lead` — `confirmed` with the issue it raised,
   or `rejected` with a one-line reason. The scan belongs to the PR head, not the walkthrough: `HunkScanService`
   (`services/hunk-scan/HunkScan.ts`) starts it when the review page loads the diff, and a walkthrough
   job for the same head joins that run or reads its result — waiting at most
   `HUNK_SCAN_JOIN_BUDGET_MS`, then starting with the leads answered so far (one run per PR,
   at most two PRs scanning at once; the scan lives in a daemon fiber, so a walkthrough Stop
   doesn't cut it short, and a newer head interrupts it). Its lifecycle is
   `hunk_scans.status`, keyed on `(pr_id, head_sha)`: `running` → `complete` | `partial` (a
   circuit breaker stopped it after Jev stopped answering) | `failed` (nothing answered; rows
   deleted, as if it never ran). A walkthrough never reruns a finished scan; reopening the
   review page retries a `failed` or `partial` one. A scan whose rows no longer match the
   diff it's handed (it was seeded from a stale diff) is re-seeded, keeping the answers that
   still match. A scan cut off while `running` resumes from the journal on the next ask.
   - **Phase A — Overview.** One atomic write: `set_overview(summary, risk_level?)`.
     `last_completed_phase` becomes `'A'`. When Jev answers at job start, the risk tier is
     the orchestrator's (invariant 2's carve-out): written with its confidence before the
     agent runs, handed to it as a given that governs its issue budget and depth, and a
     `risk_level` the agent sends is ignored. Only when Jev is off or doesn't answer
     (`risk_confidence` stays null) does `set_overview`'s `risk_level` set the tier.
   - **Phase B — Diff Analysis.** Multi-step, in chapters. `add_semantic_step(
     semantic_step_index, title, summary?, initial_block)` opens a chapter and writes its
     block 0 in one transaction (the first call advances the pipeline to `'B'`);
     `add_diff_step(semantic_step_index, step_index, block)` appends one block to an open
     chapter. Blocks are keyed on `(walkthrough_id, phase, semantic_step_index,
     step_index)`; each call is exactly one block, and batching is forbidden at the
     tool-surface level.

     Two Phase-B tools defer to a Jev judgment, in opposite directions:

     `flag_issue` writes its row and returns, then a **background** judgment retracts the
     concern if it doesn't clear the relevance floor and relabels its severity against a
     fixed rubric. Non-blocking on purpose — a round trip per concern sat on Phase B's
     critical path. That makes the issue set eventually consistent during Phase B, which is
     fine everywhere except two places, both closed in `ai/jev/pending.ts`:
     `complete_walkthrough` drains every scheduled judgment before it validates anything,
     and `add_issue_comment` answers a retracted id with an explanatory non-error rather
     than "unknown issue". A retraction deletes linked `comment_threads` by FK cascade and
     broadcasts `issue:deleted`; a concern already pushed to GitHub (`submittedAt`) is never
     touched. Anything the agent marked `critical`, or that the rubric reads as must-fix, is
     pinned above the floor and can never be retracted. Because severity isn't final when
     `flag_issue` returns, **every line-anchored concern owes an inline comment**, whatever
     severity the agent sent.

     `add_diff_step` / `add_semantic_step` hold an `artifact` block to its craft bar
     **synchronously**, and refuse a block that fails two of the three clauses. A gate that
     rejects has to answer before the write — a block that appeared and then vanished would
     leave a hole in the chapter's `step_index` sequence — and artifacts are rare enough
     that the round trip doesn't matter.

     Both degrade to the pre-Jev behaviour when the judgment is unavailable: an unjudged
     concern stands as written, an unjudged artifact is accepted. Judgments are cached on
     content, so a replay stays a no-op (invariant 3).
     A third hook is purely advisory and gates nothing: a voice check samples the first
     few markdown blocks in the background and hands its verdict back on a *later*
     `add_diff_step` result, so the agent can course-correct without any block paying a
     round trip. Nothing downstream reads it.

   - **Phase C — Overall Sentiment.** One atomic write: `set_sentiment(markdown)`.
     Implicitly closes Phase B (requires ≥1 diff step).
   - **Phase D — 9-Axis Rating.** Nine atomic writes via `rate_axis(axis, ...)`. Keyed on
     `(walkthrough_id, axis)` with `onConflictDoUpdate`. `last_completed_phase` becomes
     `'D'` only when all 9 axes carry a non-empty `rationale`. The agent owns every verdict.
     It sends all nine calls as parallel tool calls in one turn: each is still its own
     atomic write, and because the handler is one synchronous transaction, they may land
     in any order and exactly one of them advances the phase.
5. **Phase preconditions are tool-level.** Out-of-order calls fail fast with a structured
   error the agent can recover from.
6. **Resumption reads state via an MCP read tool**, not env vars. On every run start,
   including resumes, the agent calls `get_walkthrough_state(walkthrough_id)` first.
7. **Walkthroughs are immutable per head SHA during generation.** The 4-phase generation
   pipeline never mutates a walkthrough row for the same head SHA — a new commit produces
   a new walkthrough row, and the old is marked `'superseded'`. `superseded_by` names the
   replacing row only when that row was created at the old one's key (a do-over at the same
   head); a head move or a Regenerate retires rows before any replacement exists, so it
   stays NULL by design. A resume runs a row at its own head, never the PR's current one: a
   row whose PR has moved on is superseded instead.

   The snapshot importer that hydrates team-cache hits also carries a review over a pure
   restack: when a stacked layer's new head has a fingerprint identical to a finished review's
   (`walkthroughs.diff_fingerprint`), the orchestrator imports that review into the new head's
   row (`carried_from_walkthrough_id`) with no agent run. The old row is never touched.

   **Carve-out: chat-edit is the single authorized post-completion mutation path.** After
   `status='complete'`, the chat agent's edit MCP tools (`update_overview`, `add_block`,
   `update_block`, `delete_block`, `add_semantic_step`, `update_semantic_step`,
   `delete_semantic_step`, `update_sentiment`, `update_rating`, `delete_rating`,
   `add_issue`, `update_issue`, `delete_issue`, `add_issue_comment`,
   `update_issue_comment`, `delete_issue_comment`) may mutate rows in place. Edits stamp
   `lastEditedAt` / `lastEditedBy` on the parent row, never change `status` or
   `lastCompletedPhase`, and broadcast `walkthrough:event` envelopes carrying a
   `lifecycle:edited` event on the global SSE stream (`GET /api/events`). GitHub-submitted issues
   (`submittedAt!=null`) are off-limits even to the chat-edit path. The generation
   pipeline still never mutates a completed row.

   The external coding-agent integrations (Claude Code, Codex, OpenCode,
   Cursor) are additional scoped callers of the same chat-edit handlers. Their
   `record_issue_resolution` tool may update only the local resolution
   metadata of an unsubmitted issue; GitHub-submitted issues remain immutable
   and must be addressed through their comment thread. Their
   `request_walkthrough` tool asks the orchestrator to generate a review of a
   pushed head; it goes through `WalkthroughJobs.startJob` (pinned to that
   head, `trigger: 'external_agent'`) and never writes lifecycle fields
   itself. All four share one
   credential model, one stdio bridge, and one MCP route — see
   `docs/architecture/external-agent-integrations.md`.
8. **Commit first, broadcast second.** DB upsert is the commit point. SSE
   broadcast is best-effort. Subscribers reconnecting after a miss MUST reconcile by
   re-reading the DB. Durable walkthrough events carry the row's seq
   (`walkthrough:event`); live-only ones (reasoning, exploration, the gauge, the phase)
   go out unsequenced on `walkthrough:live` and are never replayed.
9. **Bounded retries with explicit budgets.** `MAX_RESUME_ATTEMPTS = 3` (every durable
   job, `services/jobs/agent-jobs.ts`), `MAX_AUTO_CONTINUATIONS = 2`,
   `MAX_CONCURRENT_JOBS = 5`. Exceeding marks the row terminal (`error`, end reason
   `resume_budget` / `budget_exhausted`) and stops. A read path that finds a row whose run
   died (the recap stream, a brief's `ensure`) resumes it through the same budget.
10. **Per-job resource scoping.** Each walkthrough job owns a dedicated detached git
    worktree at `head_sha` (`RepoClone.acquireReviewWorktree`, keyed on the walkthrough id),
    removed by a scope finalizer on every exit path; a resumed job clears what its killed run
    left, and the worktree sweep removes those of walkthroughs no longer generating. Generation
    never reads the PR's agent worktree (`pr-N` on `revv/pr-N`), which belongs to the chat
    agent: `PrWorkspace` holds one claim per PR for it, so a chat turn, a push of the agent's
    commits and an edit of them never overlap, and the server refuses the second rather than
    racing in the worktree.
11. **Status transitions are orchestrator-only.** Agents never write `status` or
    `last_completed_phase` directly. MCP tool handlers update phase fields as a side-effect
    of their own writes; `status ∈ {generating, complete, error, superseded}` is only ever
    set by `WalkthroughJobs` (`services/walkthrough/lifecycle.ts`), which also records why
    a run ended without completing (`walkthroughs.end_reason`, `WalkthroughEndReason`).
12. **`complete_walkthrough` is a validation gate.** Asserts `last_completed_phase = 'D'`
    AND summary/sentiment non-empty AND ≥1 diff step AND the chapter rules (the reviewer
    journey chapter at index 0, no orphan block, no empty chapter) AND all 9 axes rated with
    a rationale AND every line-anchored concern commented. The requirements are one list
    (`services/walkthrough/completion.ts`); the tool's description and the system prompt
    render from it. The gate and the orchestrator decide on one journal check
    (`walkthroughCompletionBlockers`):
    a run's turn reports only how it ended, and the run is `complete` exactly when the
    journal passes. The check's lead blocker is the tool's alone: the orchestrator
    completes a run with unresolved leads, so a skipped hint never costs the review.
13. **Agent parity.** ACP is the only agent transport, and every ACP agent must exhibit
    identical externally-observable behavior during a review. Divergence in the model's
    reasoning style is allowed; divergence in events, lifecycle, phase transitions, retry, or
    resume semantics is a bug. Per-agent facts live only in the registry entry
    (`ACP_AGENTS` in `@revv/shared`: launch argv, CLI, catalog, capabilities) and the agent's
    server adapter (`ai/acp/agents/<id>.ts`: env, model/effort routing, auth probe), keyed by
    `AcpAgentId`; the drivers never branch on which agent is running. Every turn runs through
    one runner (`ai/acp/run-turn.ts`), so connect, session, deadline and cancel behaviour is
    the same code for every feature and every agent.
14. **ACP connection lifecycle.** Agent subprocesses live in an in-memory pool
    (`ai/acp/acp-connection.ts`, reached only through the turn runner) keyed on (working
    directory, agent, model, effort) — the `AgentLaunch` that `resolveAgentLaunch` returns,
    which also keys the chat session row: one subprocess per key, shared by every caller
    with that key. A subprocess is spawned lazily on first use (the chat panel's
    session-context warm-up counts as a use), must finish its handshake within 3 minutes,
    is held warm by a refcount of in-flight turns, and is killed `IDLE_STOP_MS` (5 min)
    after the last turn ends. A turn that is cancelled or hits a deadline cancels its own
    session (`session/cancel`), never the shared subprocess; if the agent ignores the cancel
    the subprocess is retired: later turns get a fresh one, and it is killed once the turns
    still on it end. When a subprocess exits for any reason it leaves the pool and the next
    use spawns a fresh one, with none of the old one's per-session state (listeners, mode
    and model selections). Nothing correctness-bearing may depend on an ACP session
    surviving: walkthrough, recap and stack-brief runs always open a fresh session and
    rebuild context from the DB (invariant 6); chat resumes via `session/load` where the
    agent supports it, and a session that can't be reloaded becomes a fresh one that gets
    the system prompt and the conversation again. Every subprocess is stopped when the
    runtime is disposed (the boot layer's finalizer). The pool and the per-run MCP bearer
    tokens (one TTL'd store, `session-token-store.ts`) are ephemeral and never persisted
    (invariant 1).

### Stack briefs

Walkthroughs, recaps and stack briefs all run on one durable agent-job kernel
(`makeAgentJobs`, `services/jobs/agent-jobs.ts`): the registry, concurrency, launch,
cancel, the MCP token (TTL derived from the turn ceiling), the run's verdict (a user Stop
settles as the pipeline's stop — a walkthrough ends `error` with end reason `cancelled`,
still resumable; a recap `stopped` —, a supersede leaves the row to its superseder, an unasked-for
interrupt leaves it `generating`, otherwise the journal check decides) and the one resume
policy (a journal that already passes completes without a rerun; otherwise the attempt is
counted first). Each pipeline supplies its journal reads and its `settle`. Boot work runs
from one declared sequence (`src/boot.ts`) built with the runtime.

The stack brief (the arc of a GitHub PR stack, each open layer's role, and a review
order) is a third agent pipeline under the same invariants. `StackBriefJobs`
(`services/stacks/StackBriefJobs.ts`) is its orchestrator: one `stack_briefs` row per
stack version (`signature`, the ordered open layers' `number@headSha`), with the stack
snapshotted onto the row at creation so a resume needs neither GitHub nor memory. A new
version supersedes the stack's older briefs (`superseded_by`). Concurrency 1, resume
budget 3 (`resume_attempts`), resume-on-boot, no worktree; it runs the user's walkthrough
agent and model. Content arrives only through `/mcp/stack-brief`, in two phases:
**L** (`set_layer_role`, one upsert per layer keyed on `(brief_id, position)`; the phase
advances when every snapshot layer has a row) then **R** (`set_arc`, refused until every
layer has a role). `get_stack_brief_state` comes first on every run; `get_stack_layers`
reads the evidence; `complete_stack_brief` is the validation gate. The gate and the
orchestrator decide on one pure journal check (`stackBriefCompletionBlocker`): a run whose
journal passes it completes even if the agent never called the gate. `status` is
orchestrator-only and every transition is broadcast as `stack-brief:status-changed` after
it commits. Review-the-stack (`services/stacks/StackReview.ts`) only queues walkthroughs
through `WalkthroughJobs.startJob` (`trigger: 'stack_review'`) and asks for a brief once
they settle; it owns no walkthrough or brief lifecycle. Its own row (`stack_reviews`)
journals the queue and progress, `running` → `done` | `abandoned` (a 2-hour deadline), so a
restart picks a review up where it was.

### Implications for new agent features (e.g., PRD-05)

New agent subsystems must mirror this architecture: a durable journal row that is the job
(`status` + phase enum + `resume_attempts`), MCP tool surface with phase preconditions, orchestrator
owns lifecycle, resume-on-boot — by running on the agent-job kernel (`makeAgentJobs`) with
one journal completion check shared by the gate and the orchestrator. If you find yourself adding in-memory state that couldn't
survive a `kill -9`, stop — you're building on sand.

## Performance investigations

For trace reviews, stack profiling, or performance fixes, follow
[`docs/performance.md`](docs/performance.md). Run `bun run perf:review` to collect
ranked trace evidence and sampled stack summaries. Use separate bounded profiles
and equivalent unprofiled before/after benchmarks. A latency ranking alone is not
proof of a CPU bottleneck or an improvement. Preserve the subsystem invariants
and record reproducible evidence with each proposed optimization.

## Operational Reminders

Before concluding any task that touches code, **always run the full CI pipeline locally** and ensure it passes:

```bash
bun run typecheck && bun run lint && bun run knip && bun run build
```

Do not consider a task complete while any of these steps fail. Fix lint errors, unused exports, type errors, and build failures before committing or pushing.
