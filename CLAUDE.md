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
make dev                 # All 3 services (web @ 5173, server @ 45678, Tauri desktop)
make dev-web             # SvelteKit only
make dev-server          # Elysia API only

# Quality
make typecheck           # tsc across all packages
make lint                # Linters across all packages

# Build & Distribution
make build               # Build all packages
make dist                # Build platform installer (dmg/msi/deb)

# Cleanup
make clean               # Remove build artifacts
make reset-db            # Delete SQLite database (apps/server/revv.db)
```

## Architecture

### Monorepo Layout

- `apps/web` — SvelteKit frontend (served by Tauri, also accessible at `localhost:5173` in dev)
- `apps/server` — Elysia HTTP + WebSocket server (port 45678)
- `apps/desktop` — Tauri v2 shell; minimal Rust, just window + plugin setup
- `packages/shared` — Shared types, constants (`API_PORT`, `APP_NAME`), and WebSocket message schemas

`packages/shared` is the source of truth for cross-app types. Import from `@revv/shared`.

### Server (`apps/server`)

- **Effect system** throughout: services use `Effect.gen`, `Context.Tag`, and `Layer` for DI and structured error handling. Don't bypass Effect when modifying services.
- **Services**: `GitHubService`, `RepositoryService`, `PullRequestService`, `PollScheduler`, `WebSocketHub`, `Settings`, `TokenProvider`
- **Auth**: `better-auth` with GitHub OAuth. Bearer token strategy. OAuth callback URL: `http://localhost:45678/api/auth/callback/github`
- **Database**: Drizzle ORM on SQLite (`revv.db`). Schema in `src/db/schema.ts`. No migration runner — schema is applied directly.
- **WebSocket**: Clients authenticate via `?token=` query param. Server broadcasts `prs:updated`, `repos:updated`, etc. via `WebSocketHub`.

### Web (`apps/web`)

- **Svelte 5 runes** (`$state`, `$derived`, `$effect`) — not Svelte 4 stores/writables.
- **Stores** (in `src/lib/stores/`): `auth.svelte.ts`, `prs.svelte.ts`, `ws.svelte.ts`, `settings.svelte.ts`. These expose getter/setter functions, not subscribables.
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

**Always use icons, never emojis.** For any glyph in the UI — buttons, fallback avatars, placeholders, status indicators, empty states, inline hints — use an icon component (`@lucide/svelte`, or an inline SVG for brand/octicon-style marks). Do not use emoji characters (🎉, ✅, ❌, 👤, etc.) in rendered UI, toast messages, or component text. Existing Lucide imports are the preferred source; only inline SVG when no Lucide equivalent fits.

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
7. **Walkthroughs are immutable per head SHA.** A new commit produces a new walkthrough row;
   the old is marked `'superseded'` with a `superseded_by` back-reference. Never mutate
   in place.
8. **Commit first, broadcast second.** DB upsert is the commit point. SSE/WebSocket
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
14. **Agent-daemon lifecycle.** Agent daemons (e.g., `opencode serve`) are lazy-started
    only when the selected agent requires them and an active job needs them; they are
    stopped when idle or when the selected agent changes. Their credentials and bound
    port are ephemeral and never persisted.

### Implications for new agent features (e.g., PRD-05)

New agent subsystems must mirror this architecture: durable `*_jobs` table with `status` +
phase enum + `resumeAttempts`, MCP tool surface with phase preconditions, orchestrator
owns lifecycle, resume-on-boot. If you find yourself adding in-memory state that couldn't
survive a `kill -9`, stop — you're building on sand.
