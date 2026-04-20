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
curl -fsSL https://raw.githubusercontent.com/alexandre-schaffner/revv/main/install.sh | bash
```

That single command will:

1. Install build prerequisites if missing (Xcode CLT, Bun, Rust)
2. Clone the source to `~/Library/Application Support/Revv/src`
3. Build `Revv.app` (`make dist`) and copy it to `/Applications`
4. Install a LaunchAgent so the API server runs in the background on login
5. Install a `revv` CLI to `~/.local/bin` for updates and maintenance

No OAuth prompts and no `.env` file to manage — Revv ships with a bundled GitHub OAuth App, and `BETTER_AUTH_SECRET` is generated on first run and stored at `~/Library/Application Support/Revv/auth.key` (mode `0600`). Nothing sensitive ever leaves your machine.

### Non-interactive / customization

The installer honors a few environment variables — everything else is baked in:

```bash
REVV_AUTO_YES=1 \
REVV_BRANCH=main \
REVV_INSTALL_DIR="$HOME/Library/Application Support/Revv/src" \
REVV_APP_DIR=/Applications \
  bash <(curl -fsSL https://raw.githubusercontent.com/alexandre-schaffner/revv/main/install.sh)
```

| Variable | Default | Purpose |
|---|---|---|
| `REVV_AUTO_YES` | `0` | `1` skips every confirm prompt (same as `--yes`) |
| `REVV_BRANCH` | `main` | Branch to clone/update |
| `REVV_REPO_URL` | Upstream | Git URL to clone from (fork-friendly) |
| `REVV_INSTALL_DIR` | `~/Library/Application Support/Revv/src` | Where the source tree lives |
| `REVV_APP_DIR` | `/Applications` | Falls back to `~/Applications` if not writable |

Revv bundles an OAuth App registered on `nocturlab.ghe.com` (GitHub Enterprise Cloud). To self-host against a different GitHub instance — public github.com or your own GHE Server — override **both** `GITHUB_CLIENT_ID` and `GITHUB_HOST` in the LaunchAgent's `EnvironmentVariables` after install (or edit the defaults in `apps/server/src/config.ts`). The OAuth App must have **Device Flow enabled** — see Troubleshooting.

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
./install.sh --dev    # installs toolchain + runs `bun install`, stops there
```

`install.sh` is a single script with two modes. Running it **from a checkout with `--dev`** only prepares the tree for `make dev` — it does not build or install `Revv.app` or the LaunchAgent. Without `--dev` it runs the full user install (same as the curl one-liner above).

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
- GitHub device-code sign-in (`src/routes/device-auth.ts`), sessions via `better-auth`
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

GitHub **Device Code** OAuth flow. The server calls `POST https://github.com/login/device/code` with the bundled `client_id` (no client secret — device flow doesn't use one), returns a `user_code` + `verification_uri` to the desktop client, and polls GitHub until the user approves the code in their browser. On success the server mints a 30-day session token, stored client-side and passed to the API as `Authorization: Bearer`.

`better-auth` is present for session/account storage plumbing, but the interactive sign-in path is the device-code endpoints in `apps/server/src/routes/device-auth.ts` — not a browser-redirect callback.

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

SQLite with Drizzle ORM. Schema in `apps/server/src/db/schema.ts`; migrations in `apps/server/src/db/migrations/` (generated by `drizzle-kit` and applied by `migrate()` on server startup). The database lives at `apps/server/revv.db` by default; override with `REVV_DB_PATH`.

To generate a new migration after changing `schema.ts`:

```bash
cd apps/server && bun run drizzle-kit generate
```

To reset the local DB entirely: `make reset-db`.

## TypeScript

All packages extend `tsconfig.base.json` with:
- `strict` mode enabled
- `exactOptionalPropertyTypes` enforced
- `noUncheckedIndexedAccess` enforced

Avoid suppressing errors with `as` casts unless unavoidable.

## API Endpoints

See `apps/server/src/routes/` for full API docs. Key endpoints:

**Auth (device-code flow)**
- `POST /api/auth/device/init` — Start device flow; returns `device_code`, `user_code`, `verification_uri`
- `POST /api/auth/device/poll` — Exchange an approved `device_code` for a session token

**Data**
- `GET /api/prs` — List pull requests
- `GET /api/repos` — List repositories
- `POST /api/reviews` — Create or update review
- `GET /api/reviews/:id` — Fetch review

All data endpoints require `Authorization: Bearer <session-token>`. The WebSocket at `ws://localhost:45678` authenticates via `?token=<session-token>` query param.

## Troubleshooting

### `Failed to start sign-in: TypeError: Load failed`

The desktop app can't reach the local API server. Check it's running:

```bash
curl http://localhost:45678/       # expect a response (404 on `/` is fine)
launchctl list | grep revv         # PID in column 1 means running; `-` means crashed
revv logs                          # tail ~/Library/Logs/Revv/server.{out,err}.log
```

If crashed, `revv logs` will show the reason. Common cause: a stale LaunchAgent from a previous broken build — `revv restart` usually resolves it.

### `Failed to start sign-in: Error: Failed to initiate sign-in`

Server is reachable but GitHub returned 502. `revv logs` will show the real cause; almost always one of:

- **GitHub 404 Not Found** — you're using a custom `GITHUB_CLIENT_ID` but the OAuth App does not have **Device Flow enabled**. Fix it at `github.com/settings/developers` → your app → check "Enable Device Flow" → **Update application**.
- **Invalid `client_id`** — the env var is set to a typo or a non-existent App.

### `revv status` / `revv doctor`

Both ship with the `revv` CLI and print install paths, service state, and run basic health checks. Start there.

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
