# Rev — AI-Powered Code Review

An intelligent code review desktop application that brings AI-assisted analysis to your pull request workflows. Rev syncs your GitHub PRs and enables deep, conversational code review right from your desktop.

## Features

- **Synced GitHub PRs** — Automatically fetch and organize your pull requests
- **AI Code Review** — Get intelligent analysis and suggestions on code changes
- **Annotation & Comments** — Add detailed annotations to specific lines and participate in review threads
- **Guided Walkthroughs** — Step-by-step guidance for understanding complex changes
- **Dark Mode Support** — Review code comfortably in any lighting condition

## Stack

- **Frontend** — Svelte 5 (SvelteKit) + Tailwind CSS v4 + shadcn-svelte
- **Backend** — Bun + TypeScript + Elysia + Effect
- **Database** — SQLite with Drizzle ORM
- **Desktop** — Tauri v2 (Rust)
- **Monorepo** — Turborepo

## Quick Start

### Prerequisites

- Node.js 18+ or Bun 1.0+
- Git
- GitHub OAuth credentials (see [Setup](#setup))

### Installation

```bash
# Clone and install
git clone <repo-url>
cd rev
bun install
```

### Setup

1. Create a GitHub OAuth App:
   - Go to Settings → Developer settings → OAuth Apps → New OAuth App
   - Set Authorization callback URL to `http://localhost:45678/api/auth/callback/github`
   - Copy the Client ID and Client Secret

2. Create `.env` at the repo root:
   ```env
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   ```

### Development

```bash
# Start all services (web @ 5173, server @ 45678, Tauri desktop)
make dev

# Or run individually
make dev-web              # SvelteKit only
make dev-server           # Elysia API only
```

## Commands

```bash
make typecheck           # Type check all packages
make lint                # Lint all packages
make build               # Build all packages
make dist                # Build installers (dmg/msi/deb)
make clean               # Clean build artifacts
make reset-db            # Reset SQLite database
```

## Project Structure

```
rev/
├── apps/
│   ├── web/            # SvelteKit frontend (served by Tauri)
│   ├── server/         # Elysia HTTP + WebSocket API
│   └── desktop/        # Tauri v2 shell
├── packages/
│   └── shared/         # Shared types & constants
└── CLAUDE.md           # Developer guide
```

### apps/web

SvelteKit frontend with Svelte 5 runes. Accessible at `localhost:5173` in dev.

- `src/lib/stores/` — State management (auth, PRs, WebSocket)
- `src/lib/components/` — Reusable UI components
- `src/routes/` — Page routes

### apps/server

Elysia API server with Effect-based services. Runs on port 45678.

- `src/services/` — Core services (GitHub, Repositories, PRs)
- `src/routes/` — API endpoints
- `src/db/` — Database schema (Drizzle)

**Features:**
- GitHub OAuth with `better-auth`
- WebSocket for real-time updates
- Polling & syncing of PRs from GitHub

### apps/desktop

Tauri v2 desktop shell serving the SvelteKit build.

- Deep-link handling via `rev://` scheme
- Plugin setup for opener and deep-link support
- Configured for localhost API calls via CSP

### packages/shared

Shared types and constants imported by all apps.

```ts
import { API_PORT, APP_NAME } from '@rev/shared'
```

## Architecture Highlights

### Authentication

GitHub Device Code OAuth flow via `better-auth`. Token stored client-side, passed to API via Bearer token.

### Real-Time Updates

WebSocket hub broadcasts events:
- `prs:updated` — Pull request list changed
- `repos:updated` — Repository list changed

Clients authenticate via `?token=` query param.

### Effect System

Services throughout the backend use Effect for:
- Dependency injection (`Context.Tag`, `Layer`)
- Structured error handling
- Composable async workflows

Don't bypass Effect when modifying services.

### Database

SQLite with Drizzle ORM. Schema in `src/db/schema.ts`.

**Note:** No migration runner — schema is applied directly on server start.

## TypeScript

All packages extend `tsconfig.base.json` with:
- `strict` mode enabled
- `exactOptionalPropertyTypes` enforced
- `noUncheckedIndexedAccess` enforced

Avoid suppressing errors with `as` casts unless unavoidable.

## API Endpoints

See `apps/server/src/routes/` for full API docs. Key endpoints:

- `POST /api/auth/callback/github` — OAuth callback
- `GET /api/auth/pending-token` — Poll for pending token (browser dev)
- `GET /api/prs` — List pull requests
- `GET /api/repos` — List repositories
- `POST /api/reviews` — Create or update review
- `GET /api/reviews/:id` — Fetch review

## Roadmap

See `docs/prds/` for the product roadmap. Six sequential PRDs outline the feature pipeline:

1. Comment Persistence & Review Sessions (P0)
2. AI Context Panel (P0)
3. AI Guided Walkthrough (P1)
4. GitHub Sync & Conversations (P1)
5. Post-Review Agent (P1)
6. Polish, Performance & Ship (P2)

## Contributing

1. Create a feature branch
2. Make changes and test with `make dev`
3. Run `make typecheck` and `make lint` before committing
4. Open a pull request against `main`

## License

MIT
