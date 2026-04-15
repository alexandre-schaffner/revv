# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Rev** is an AI-powered code review desktop application. It's a Tauri v2 desktop app with a SvelteKit frontend and a local Bun/Elysia API server that syncs GitHub pull requests and enables AI-assisted review workflows.

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
make reset-db            # Delete SQLite database (apps/server/rev.db)
```

## Architecture

### Monorepo Layout

- `apps/web` — SvelteKit frontend (served by Tauri, also accessible at `localhost:5173` in dev)
- `apps/server` — Elysia HTTP + WebSocket server (port 45678)
- `apps/desktop` — Tauri v2 shell; minimal Rust, just window + plugin setup
- `packages/shared` — Shared types, constants (`API_PORT`, `APP_NAME`), and WebSocket message schemas

`packages/shared` is the source of truth for cross-app types. Import from `@rev/shared`.

### Server (`apps/server`)

- **Effect system** throughout: services use `Effect.gen`, `Context.Tag`, and `Layer` for DI and structured error handling. Don't bypass Effect when modifying services.
- **Services**: `GitHubService`, `RepositoryService`, `PullRequestService`, `PollScheduler`, `WebSocketHub`, `Settings`, `TokenProvider`
- **Auth**: `better-auth` with GitHub OAuth. Bearer token strategy. OAuth callback URL: `http://localhost:45678/api/auth/callback/github`
- **Database**: Drizzle ORM on SQLite (`rev.db`). Schema in `src/db/schema.ts`. No migration runner — schema is applied directly.
- **WebSocket**: Clients authenticate via `?token=` query param. Server broadcasts `prs:updated`, `repos:updated`, etc. via `WebSocketHub`.

### Web (`apps/web`)

- **Svelte 5 runes** (`$state`, `$derived`, `$effect`) — not Svelte 4 stores/writables.
- **Stores** (in `src/lib/stores/`): `auth.svelte.ts`, `prs.svelte.ts`, `ws.svelte.ts`, `settings.svelte.ts`. These expose getter/setter functions, not subscribables.
- **API client**: Eden (Elysia type-safe client) — import from `@rev/server` types.
- **Deep-link handling**: OAuth callback comes in via `rev://auth/callback?token=…` scheme (Tauri) or polling `/api/auth/pending-token` (browser dev mode).
- **Component library**: shadcn-svelte + Tailwind CSS v4.

### Desktop (`apps/desktop`)

- Tauri v2. Frontend served from `../web/build`. Dev URL: `http://localhost:5173`.
- Plugins: `tauri-plugin-deep-link` (handles `rev://` scheme), `tauri-plugin-opener`.
- CSP restricts API calls to `localhost:45678`.

## TypeScript Config

All packages extend `tsconfig.base.json` which enables `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`. These are enforced — don't suppress errors with `as` casts unless unavoidable.

## Environment

The only required env vars are in `.env` at the repo root (read by `apps/server`):

```
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
```

Create a GitHub OAuth App with callback URL `http://localhost:45678/api/auth/callback/github`.

## Product Direction

`docs/prds/` contains 6 sequential PRDs describing the remaining feature roadmap. The README there documents what's already built vs what's next. Read these before implementing new features to understand intended design.

| PRD | Title | Priority |
|-----|-------|----------|
| 01 | Comment Persistence & Review Sessions | P0 |
| 02 | AI Context Panel | P0 |
| 03 | AI Guided Walkthrough | P1 |
| 04 | GitHub Sync & Conversations | P1 |
| 05 | Post-Review Agent | P1 |
| 06 | Polish, Performance & Ship | P2 |
