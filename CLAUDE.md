# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Revv** is an AI-powered code review desktop application. It's a Tauri v2 desktop app with a SvelteKit frontend and a local Bun/Elysia API server that syncs GitHub pull requests and enables AI-assisted review workflows.

Stack: Bun + TypeScript monorepo (Turborepo), Svelte 5, Elysia, Drizzle ORM on SQLite, Tauri v2 (Rust).

## Commands

```bash
# Setup
bun install              # Install all workspace deps
cp .env.example .env     # Then fill in GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET

# Development
make dev                 # All services (web @ 5173, server @ 45678, Tauri desktop)
make dev-server          # Elysia API only

# Quality
make typecheck           # tsc across all packages
make lint                # Linters across all packages

# Build & Distribution
make build               # Build all packages
make dist                # Build platform installer (dmg/msi/deb)

# Database
cd apps/server && bunx drizzle-kit generate   # Generate migration from schema changes

# Cleanup
make clean               # Remove build artifacts
make reset-db            # Delete SQLite database (apps/server/revv.db)
```

## Architecture

### Monorepo Layout

- `apps/web` — SvelteKit frontend rendered by the Tauri desktop shell (from the Vite dev server at `localhost:5173` in dev, from `../web/build` in prod). Revv is a desktop-only app; the frontend is not a standalone browser app.
- `apps/server` — Elysia HTTP + SSE server (port 45678)
- `apps/desktop` — Tauri v2 shell; minimal Rust, just window + plugin setup
- `packages/shared` — Shared types, constants (`API_PORT`, `APP_NAME`), and SSE event message schemas

`packages/shared` is the source of truth for cross-app types. Import from `@revv/shared`.

### Server (`apps/server`)

- **Effect system** throughout: services use `Effect.gen`, `Context.Tag`, and `Layer` for DI and structured error handling. Don't bypass Effect when modifying services.
- **Services**: `GitHubService`, `RepositoryService`, `PullRequestService`, `PollScheduler`, `Broadcaster`, `Settings`, `TokenProvider`
- **Auth**: `better-auth` with GitHub OAuth. Bearer token strategy. OAuth callback URL: `http://localhost:45678/api/auth/callback/github`
- **Database**: Drizzle ORM on SQLite (`revv.db`). Schema in `src/db/schema.ts`. Migrations live in `src/db/migrations` and are auto-applied on startup via `drizzle-orm/bun-sqlite/migrator`. Generate new ones with `bunx drizzle-kit generate` (run from `apps/server`).
- **Realtime (SSE)**: Clients open a single `GET /api/events?token=…` stream. Server broadcasts `prs:updated`, `repos:updated`, etc. via `Broadcaster` (account-scoped fan-out). Inbound commands use REST endpoints.

#### Database migrations

The project uses **Drizzle's code-first migration workflow**.

**How it works:**
1. **Schema is the source of truth.** All tables, indexes, and relations are defined in TypeScript under `apps/server/src/db/schema/`.
2. **Generate a migration** after changing the schema by running `cd apps/server && bunx drizzle-kit generate`. This compares the current schema against the database state and writes a new `.sql` file + a `meta/` snapshot into `src/db/migrations/`.
3. **Migrations are applied automatically on startup.** `src/db/index.ts` calls `migrate()` from `drizzle-orm/bun-sqlite/migrator` using the `src/db/migrations` folder. You do **not** need to run `drizzle-kit migrate` or `drizzle-kit push` manually.
4. **Migration state is tracked** in a `__drizzle_migrations` table inside `revv.db`. Already-applied migrations are skipped on subsequent starts.

**Expected agent workflow when schema changes are needed:**
1. Edit the Drizzle schema files in `apps/server/src/db/schema/`.
2. Generate the migration: `cd apps/server && bunx drizzle-kit generate`.
3. Review the generated `.sql` file in `apps/server/src/db/migrations/` for correctness.
4. Restart the server (`make dev-server` or `make dev`). The startup routine will apply the new migration automatically.
5. If the generated migration is wrong (e.g., destructive defaults, wrong column types), **edit the generated `.sql` file before restarting** rather than trying to fix it after it has been applied.

**Do not** run `drizzle-kit push` against the local SQLite file — the app relies on the migration-file workflow for reproducible schema evolution.

### Web (`apps/web`)

- **Svelte 5 runes** (`$state`, `$derived`, `$effect`) — not Svelte 4 stores/writables.
- **Stores** (in `src/lib/stores/`): `auth.svelte.ts`, `prs.svelte.ts`, `events.svelte.ts`, `settings.svelte.ts`. These expose getter/setter functions, not subscribables.
- **API client**: Eden (Elysia type-safe client) — import from `@revv/server` types.
- **Deep-link handling**: OAuth callback comes in via `revv://auth/callback?token=…` scheme (Tauri) or polling `/api/auth/pending-token` (browser dev mode).
- **Component library**: shadcn-svelte + Tailwind CSS v4.

### Desktop (`apps/desktop`)

- Tauri v2. Frontend served from `../web/build`. Dev URL: `http://localhost:5173`.
- Plugins: `tauri-plugin-deep-link` (handles `revv://` scheme), `tauri-plugin-opener`.
- CSP restricts API calls to `localhost:45678`.

## TypeScript Config

All packages extend `tsconfig.base.json` which enables `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`. These are enforced — don't suppress errors with `as` casts unless unavoidable.

## UI Conventions

**Always use icons, never emojis.** For any glyph in the UI — buttons, fallback avatars, placeholders, status indicators, empty states, inline hints — use a phosphor-svelte icon component or an inline SVG for brand/octicon-style marks. Do not use emoji characters (🎉, ✅, ❌, 👤, etc.) in rendered UI, toast messages, or component text. `phosphor-svelte` is the standard icon library; only inline SVG when no phosphor equivalent fits.

**Motion: GSAP via `$lib/motion`.** All animations go through `$lib/motion` (`apps/web/src/lib/motion/`). Use the actions, presets, and Svelte transitions from there (`gsapPress`, `bitsAnim`, `dialogSpringIn`, `gsapFade`, `gsapFadeY`, `gsapSlide`, …) instead of CSS `transition:` rules, Svelte built-in transitions (`transition:fade`, `transition:slide`, …), or hand-rolled `@keyframes`. The motion tokens (`--duration-*`, `--ease-*`) in `app.css`' `@theme` block are mirrored in `$lib/motion/tokens.ts` — edit both sides when changing values. Never import `gsap` from the package directly; only `$lib/motion/gsap.ts` may.

**Reduced-motion contract.** `prefersReducedMotion()` from `$lib/motion` is the single arbiter. Every action, preset call site, and motion `$effect` reads through it. The defensive global `@media (prefers-reduced-motion: reduce)` block in `app.css` covers the CSS animations that intentionally stayed off GSAP (loader spinner, text shimmer, indeterminate progress, dotmatrix, per-character markdown fade) — see `motion/README.md` for the list.

## Code Conventions

Canonical patterns live in [`docs/conventions.md`](docs/conventions.md). Existing violations are tracked in [`docs/conventions-backlog.md`](docs/conventions-backlog.md). The rules below are the headline summary; the doc is the authority.

- **Effect services.** Service tag `XService` pairs with Layer `XServiceLive`. No `Effect.runPromise` inside an Effect-returning method — schedule with `Effect.fork` / `Effect.sleep` / `Effect.async`. Tagged errors live in `apps/server/src/domain/errors.ts`, never inline. Drizzle calls inside `Effect.gen` are wrapped in `Effect.try*` mapping to a tagged DB error. ([§2](docs/conventions.md#effect-services))
- **SSE event envelopes.** Shape is `{ type, data? }`; type strings are `namespace:action` colon-style; payload contract is one of signal / full-state / delta and documented at the type definition. Data-bearing envelopes are account-scoped (`broadcastToAccount`); `broadcastAll` is reserved for server-global sync signals. Source of truth: `packages/shared/src/events.ts`. ([§3](docs/conventions.md#event-envelopes))
- **Web stores.** Singleton module + `getX/setX` exports; per-PR state is `Map<prId, Entry>` with shared `setEntry/deleteEntry/updateEntry` helpers; every Map/Set write is followed by reassignment for reactivity; request-state is a tagged `RequestState<T>` union, not parallel boolean+nullable triples; event handlers are named `on<EventName>` matching the message type. ([§4](docs/conventions.md#stores))
- **Motion.** All durations and easings come from the `@theme` block in `app.css` (`--duration-snap/quick/smooth`, `--ease-soft/out-expo/standard`). A ceremonial tier (`--duration-ceremonial-quick/medium/slow`) is reserved for onboarding-style theatrical motion. No hand-typed `cubic-bezier(...)`, no `220ms`/`0.55s` literals. ([§5.1–5.2](docs/conventions.md#motion-tokens))
- **Svelte components.** Props declared as `interface Props` + `$props()`. Event handlers as `onclick={fn}` (lowercase property style), not `on:click`. ([§6](docs/conventions.md#components))

Proposing a new convention: open a PR editing `docs/conventions.md`; no RFC ceremony. New violations land with a matching backlog row.

## Environment

The only required env vars are in `.env` at the repo root (read by `apps/server`):

```
GITHUB_CLIENT_ID=
BETTER_AUTH_SECRET=   # Generate with: openssl rand -hex 32
```

Create a GitHub OAuth App with callback URL `http://localhost:45678/api/auth/callback/github`.

## Product Direction

`docs/prds/` contains 6 sequential PRDs describing the remaining feature roadmap. The README there documents what's already built vs what's next. Read these before implementing new features to understand intended design.

| PRD | Title                                 | Priority |
| --- | ------------------------------------- | -------- |
| 01  | Comment Persistence & Review Sessions | P0       |
| 02  | AI Context Panel                      | P0       |
| 03  | AI Guided Walkthrough                 | P1       |
| 04  | GitHub Sync & Conversations           | P1       |
| 05  | Post-Review Agent                     | P1       |
| 06  | Polish, Performance & Ship            | P2       |

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
  bound to a specific phase. Transport may be in-process (Claude Agent SDK) or HTTP
  (opencode); **tool handler implementations are always shared in-process code.**
- **Agent (stateless-across-runs worker).** In-memory reasoning state is never authoritative.
  Between runs, the agent reconstructs its context from DB via an MCP read tool.

### Invariants

1. **SQLite is authoritative.** In-memory state is a reconstructible cache. Correctness must
   survive `kill -9` at any instruction.
2. **Agent content writes go through MCP, only.** Orchestrator lifecycle writes stay in
   Elysia and must not be routed through MCP. The MCP *transport* may vary; the *handlers*
   are shared.
3. **Each MCP tool call is one atomic idempotent write** keyed on a deterministic identity.
   Replays are no-ops.
4. **Content generation is a strict 4-phase pipeline: A → B → C → D.** Phases complete in
   order. Schema enforces it; tool surface enforces it; orchestrator enforces it.
   - **Phase A — Overview + Risk.** One atomic write: `set_overview(summary, risk_level)`.
     `last_completed_phase` becomes `'A'`.
   - **Phase B — Diff Analysis.** Multi-step. Each step is exactly one atomic write:
     `add_diff_step(step_index, markdown, code_snippet?, annotations?)`. Deterministically
     keyed on `(walkthrough_id, step_index)`. Agent calls one step per call; batching is
     forbidden at the tool-surface level.
   - **Phase C — Overall Sentiment.** One atomic write: `set_sentiment(markdown)`.
     Implicitly closes Phase B (requires ≥1 diff step).
   - **Phase D — 9-Axis Rating.** Nine atomic writes via `rate_axis(axis, ...)`. Keyed on
     `(walkthrough_id, axis)` with `onConflictDoUpdate`. `last_completed_phase` becomes
     `'D'` only when all 9 axes are rated.
5. **Phase preconditions are tool-level.** Out-of-order calls fail fast with a structured
   error the agent can recover from.
6. **Resumption reads state via an MCP read tool**, not env vars. On every run start,
   including resumes, the agent calls `get_walkthrough_state(walkthrough_id)` first.
7. **Walkthroughs are immutable per head SHA during generation.** The 4-phase generation
   pipeline never mutates a walkthrough row for the same head SHA — a new commit produces
   a new walkthrough row, and the old is marked `'superseded'` with a `superseded_by`
   back-reference.

   **Carve-out: chat-edit is the single authorized post-completion mutation path.** After
   `status='complete'`, the chat agent's edit MCP tools (`update_overview`, `add_block`,
   `update_block`, `delete_block`, `add_semantic_step`, `update_semantic_step`,
   `delete_semantic_step`, `update_sentiment`, `update_rating`, `delete_rating`,
   `add_issue`, `update_issue`, `delete_issue`, `add_issue_comment`,
   `update_issue_comment`, `delete_issue_comment`) may mutate rows in place. Edits stamp
   `lastEditedAt` / `lastEditedBy` on the parent row, never change `status` or
   `lastCompletedPhase`, and broadcast `walkthrough:event` envelopes carrying a
   `lifecycle:edited` event via `Broadcaster` on the global SSE stream (`GET /api/events`),
   not the per-generation stream, which dies on `done`. GitHub-submitted issues
   (`submittedAt!=null`) are off-limits even to the chat-edit path. The generation
   pipeline still never mutates a completed row.
8. **Commit first, broadcast second.** DB upsert is the commit point. SSE
   broadcast is best-effort. Subscribers reconnecting after a miss MUST reconcile by
   re-reading the DB.
9. **Bounded retries with explicit budgets.** `WALKTHROUGH_MAX_RESUME_ATTEMPTS = 3`,
   `MAX_AUTO_CONTINUATIONS = 2`, `MAX_CONCURRENT_JOBS = 5`. Exceeding marks the row
   terminal (`error`) and stops.
10. **Per-job resource scoping.** Each job owns a dedicated git worktree at `head_sha`,
    registered as a scope finalizer so cleanup happens on every exit path.
11. **Status transitions are orchestrator-only.** Agents never write `status` or
    `last_completed_phase` directly. MCP tool handlers update phase fields as a side-effect
    of their own writes; `status ∈ {generating, complete, error, superseded}` is only ever
    set by `WalkthroughJobs`.
12. **`complete_walkthrough` is a validation gate.** Asserts `last_completed_phase = 'D'`
    AND all 9 axes rated AND summary/sentiment non-empty AND ≥1 diff step. Only then does
    the orchestrator transition `status` to `complete`.
13. **Agent-path parity.** Both agent paths (Claude Agent SDK, opencode) must exhibit
    byte-for-byte identical externally-observable behavior during a review. Divergence in
    the model's reasoning style is allowed; divergence in events, lifecycle, phase
    transitions, retry, or resume semantics is a bug.
14. **Agent-daemon lifecycle.** Agent daemons (e.g., `opencode serve`) are eagerly
    started whenever the selected agent or a per-feature override (e.g. `recap.agent`)
    requires them — including at server boot and on settings-change-toward-opencode —
    so the first job never pays the cold-start tax. They stay warm for as long as
    they are needed; they are stopped on settings-change-away-from-opencode, on
    crash-loop cap exhaustion, or on process exit. Idle-stop is a defensive fallback
    only — invoked when `jobEnded()` observes the daemon is no longer needed and the
    settings-change handler hasn't already torn it down. Their credentials and bound
    port are ephemeral and never persisted.

### Implications for new agent features (e.g., PRD-05)

New agent subsystems must mirror this architecture: durable `*_jobs` table with `status` +
phase enum + `resumeAttempts`, MCP tool surface with phase preconditions, orchestrator
owns lifecycle, resume-on-boot. If you find yourself adding in-memory state that couldn't
survive a `kill -9`, stop — you're building on sand.

## Operational Reminders

Before concluding any task that touches code, **always run the full CI pipeline locally** and ensure it passes:

```bash
bun run typecheck && bun run lint && bun run knip && bun run build
```

Do not consider a task complete while any of these steps fail. Fix lint errors, unused exports, type errors, and build failures before committing or pushing.
