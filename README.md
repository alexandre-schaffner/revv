# Revv — AI-Powered Code Review

An intelligent code review desktop application that brings AI-assisted analysis to your pull request workflows. Revv syncs your GitHub PRs and enables deep, conversational code review right from your desktop.

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

## Install on macOS (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/alexandre-schaffner/revv/main/scripts/install-macos.sh | bash
```

That single command will:

1. Install build prerequisites if missing (Xcode CLT, Bun, Rust)
2. Clone the source to `~/Library/Application Support/Revv/src`
3. Prompt once for your GitHub OAuth credentials and auto-generate `BETTER_AUTH_SECRET`
4. Run `make dist` to build `Revv.app`
5. Copy `Revv.app` to `/Applications`
6. Install a LaunchAgent so the API server runs in the background on login
7. Install a `revv` CLI to `~/.local/bin` for updates and maintenance

Before running it you need a GitHub OAuth App (`Settings → Developer settings → OAuth Apps → New OAuth App`):
- **Homepage URL:** `http://localhost:5173`
- **Authorization callback URL:** `http://localhost:45678/api/auth/callback/github`

You can also pass credentials up front to skip the prompt:

```bash
REVV_GITHUB_CLIENT_ID=xxx REVV_GITHUB_CLIENT_SECRET=yyy \
  bash <(curl -fsSL https://raw.githubusercontent.com/alexandre-schaffner/revv/main/scripts/install-macos.sh)
```

### Managing the install

```bash
revv status      # show install paths, versions, server state, update availability
revv update      # git pull + rebuild + reinstall + reload service
revv restart     # restart the background API server
revv logs        # tail ~/Library/Logs/Revv/server.{out,err}.log
revv open        # launch Revv.app
revv uninstall   # remove app, source, LaunchAgent, and the CLI itself
```

Updates are purely source-pull-and-rebuild — no signing/notarization infrastructure required.

---

## Develop from a clone

### Prerequisites

- Bun 1.3+
- Rust (via rustup)
- Xcode Command Line Tools

### Installation

```bash
git clone https://github.com/alexandre-schaffner/revv.git
cd revv
./install.sh          # provisions toolchain + prompts for GitHub OAuth creds
```

The developer installer (`./install.sh`) is distinct from the user installer
(`scripts/install-macos.sh`): it only prepares the current checkout for
`bun run dev`, it does not build or install the `.app`.

### Setup (manual alternative)

1. Create a GitHub OAuth App:
   - Go to Settings → Developer settings → OAuth Apps → New OAuth App
   - Authorization callback URL: `http://localhost:45678/api/auth/callback/github`
   - Copy the Client ID and Client Secret

2. Create `.env` at the repo root:
   ```env
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   BETTER_AUTH_SECRET=your_secret   # Generate with: openssl rand -hex 32
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
revv/
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

- Deep-link handling via `revv://` scheme
- Plugin setup for opener and deep-link support
- Configured for localhost API calls via CSP

### packages/shared

Shared types and constants imported by all apps.

```ts
import { API_PORT, APP_NAME } from '@revv/shared'
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
