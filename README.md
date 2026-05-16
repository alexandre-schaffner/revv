# Revv — AI-Powered Code Review

An AI-assisted code review desktop application. Revv syncs your GitHub pull requests and enables deep, conversational code review from your desktop — including AI-generated walkthroughs, a persistent chat agent, and proposed-commit workflows.

## Features

- **Synced GitHub PRs** — Automatic fetch and polling across repos, with real-time WebSocket updates
- **AI Guided Walkthrough** — 4-phase MCP pipeline (Overview → Diff Analysis → Sentiment → 9-axis Rating) with chat-edit mutations post-completion
- **Chat Agent** — Always-on right-panel agent with plan mode, tool-use streaming, task queue, and pending questions
- **Chat-Driven Changes** — Proposed-commit strip with cherry-pick / discard / push (`--force-with-lease`) and AI merge-conflict resolution
- **Comment Threads** — Persisted review threads with bidirectional GitHub sync, hunk decisions, and code-suggestion application
- **Command Palette** — `Cmd+P` PR search, `Cmd+Shift+P` command mode with fuzzy scoring
- **Multi-Account Auth** — GitHub Device Code flow; GHE-default with public `github.com` opt-in; multi-account management
- **Themes** — Light / dark / system with an independent diff theme preference

## Stack

- **Frontend** — Svelte 5 (SvelteKit) + Tailwind CSS v4 + shadcn-svelte
- **Backend** — Bun + TypeScript + Elysia + Effect
- **Database** — SQLite with Drizzle ORM (schema applied directly, no migration runner)
- **Desktop** — Tauri v2 (Rust)
- **Monorepo** — Turborepo
- **AI** — Claude Agent SDK (in-process) + opencode (HTTP MCP, subprocess); MCP tool handlers shared in-process

## Installation

### macOS

**Recommended — one-command installer (builds from source):**

```bash
# GitHub Enterprise (nocturlab.ghe.com) — default
curl -fsSL https://raw.githubusercontent.com/alexandre-schaffner/revv/main/install.sh | bash

# Public github.com
curl -fsSL https://raw.githubusercontent.com/alexandre-schaffner/revv/main/install.sh | \
  REVV_GITHUB_HOST=github.com \
  REVV_GITHUB_CLIENT_ID=Ov23liI36U1MLWk3kF8l \
  bash
```

The installer will:

1. Install missing prerequisites (Xcode CLT, Bun, Rust)
2. Clone the source to `~/Library/Application Support/Revv/src`
3. Build and install `Revv.app` to `/Applications`
4. Register a LaunchAgent so the API server starts on login
5. Install a `revv` management CLI to `~/.local/bin`

No `.env` file or OAuth setup required — Revv ships with a bundled GitHub OAuth App.
`BETTER_AUTH_SECRET` is generated on first run and stored at
`~/Library/Application Support/Revv/auth.key` (mode `0600`).

**Alternative — download the DMG from [Releases](https://github.com/alexandre-schaffner/revv/releases):**

Download the `.dmg` for your architecture (`aarch64` for Apple Silicon, `x86_64` for Intel),
open it, drag `Revv.app` to `/Applications`, and launch. You will need to start the API
server manually (`bun run apps/server/src/index.ts`) or use the installer script to set up
the LaunchAgent separately.

**Requires macOS 10.15 (Catalina) or later.**

#### Customizing the installer

```bash
REVV_AUTO_YES=1 \
REVV_BRANCH=main \
REVV_INSTALL_DIR="$HOME/Library/Application Support/Revv/src" \
REVV_APP_DIR=/Applications \
  bash <(curl -fsSL https://raw.githubusercontent.com/alexandre-schaffner/revv/main/install.sh)
```

| Variable | Default | Purpose |
|---|---|---|
| `REVV_AUTO_YES` | `0` | `1` skips every confirm prompt |
| `REVV_BRANCH` | `main` | Branch to clone/update |
| `REVV_REPO_URL` | Upstream | Git URL to clone from (fork-friendly) |
| `REVV_INSTALL_DIR` | `~/Library/Application Support/Revv/src` | Where the source tree lives |
| `REVV_APP_DIR` | `/Applications` | Falls back to `~/Applications` if not writable |
| `REVV_GITHUB_HOST` | `nocturlab.ghe.com` (bundled) | Override for a different GitHub instance |
| `REVV_GITHUB_CLIENT_ID` | bundled for the default host | Required when `REVV_GITHUB_HOST` is overridden |

To target a custom GHE Server, pass both `REVV_GITHUB_HOST` and `REVV_GITHUB_CLIENT_ID`
for an OAuth App with **Device Flow enabled**. These values are persisted to
`~/Library/Application Support/Revv/github.conf` so `revv update` preserves them.

#### Managing the install

```bash
revv status      # show install paths, versions, server state, update availability
revv update      # git pull + rebuild + reinstall + reload service
revv restart     # restart the background API server
revv logs        # tail ~/Library/Logs/Revv/server.{out,err}.log
revv open        # launch Revv.app
revv uninstall   # remove app, source, LaunchAgent, and the CLI itself
```

---

### Windows

Download the NSIS installer (`.exe`) from
[Releases](https://github.com/alexandre-schaffner/revv/releases) and run it.
Per-user and system-wide install modes are both supported.

The API server is **not** automatically registered as a Windows service by the installer.
Start it manually from a terminal in the source directory:

```powershell
bun run apps/server/src/index.ts
```

Or add it to Task Scheduler / NSSM yourself, pointing at the same command.

To build from source on Windows, see [Develop from a clone](#develop-from-a-clone) below.

---

### Linux

Download the **AppImage** or **`.deb`** package from
[Releases](https://github.com/alexandre-schaffner/revv/releases).

**AppImage (any distro):**

```bash
chmod +x Revv_*.AppImage
./Revv_*.AppImage
```

**Debian / Ubuntu:**

```bash
sudo dpkg -i revv_*.deb
# Or install required libs first if dpkg reports missing deps:
sudo apt-get install -f
```

The `.deb` depends on `libwebkit2gtk-4.1-0` and `libgtk-3-0`. On Ubuntu 22.04+ these are
available in the default repos. Older distros may need a PPA.

As on Windows, the API server is not registered as a system service by the package.
Start it manually:

```bash
bun run /path/to/revv/apps/server/src/index.ts
```

To set it up as a systemd user service, create
`~/.config/systemd/user/revv-server.service` pointing at the same command,
then `systemctl --user enable --now revv-server`.

To build from source on Linux, see [Develop from a clone](#develop-from-a-clone) below.

---

## Develop from a clone

### Prerequisites

All platforms need **Bun 1.3+** and **Rust** (via [rustup](https://rustup.rs)).

**macOS** — also needs Xcode Command Line Tools:

```bash
xcode-select --install
```

**Linux (Ubuntu/Debian)** — also needs Tauri system libraries:

```bash
sudo apt-get update && sudo apt-get install -y \
  build-essential curl file \
  libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev \
  librsvg2-dev patchelf libayatana-appindicator3-dev
```

**Windows** — also needs the [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
and [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (included in Windows 11; install the Evergreen bootstrapper on Windows 10).

### Setup

```bash
git clone https://github.com/alexandre-schaffner/revv.git
cd revv
bun install
cp .env.example .env   # fill in GITHUB_CLIENT_ID and BETTER_AUTH_SECRET
```

### Development

```bash
make dev             # all 3 services (web @ 5173, server @ 45678, Tauri desktop)
make dev-web         # SvelteKit only
make dev-server      # Elysia API only
```

### Quality & Build

```bash
make typecheck       # tsc across all packages
make lint            # linters across all packages
make build           # build all packages
make dist            # build platform installer (dmg/msi/deb)
make clean           # remove build artifacts
make reset-db        # delete SQLite database
```

## Project Structure

```
revv/
├── apps/
│   ├── web/            # SvelteKit frontend (served by Tauri, localhost:5173 in dev)
│   ├── server/         # Elysia HTTP + WebSocket API (port 45678)
│   └── desktop/        # Tauri v2 shell
├── packages/
│   └── shared/         # Shared types & constants (@revv/shared)
└── docs/prds/          # Product roadmap PRDs
```

## Architecture

### Authentication

GitHub **Device Code** OAuth flow. The server calls `POST https://github.com/login/device/code`, returns a `user_code` + `verification_uri` to the desktop client, and polls GitHub until the user approves. On success the server mints a 30-day session token passed to the API as `Authorization: Bearer`. Multi-account management is supported.

### Effect System

All backend services use Effect for dependency injection (`Context.Tag`, `Layer`), structured error handling, and composable async workflows. Don't bypass Effect when modifying services.

### Agent Subsystem

AI pipelines (walkthrough generation, chat agent) follow strict invariants documented in [`CLAUDE.md`](CLAUDE.md#agent-subsystem-invariants):

- SQLite is the authoritative state store — survives `kill -9`
- Agent content writes go through MCP only; orchestrator lifecycle writes stay in Elysia
- Each MCP tool call is one atomic idempotent upsert on a deterministic key
- Generation is a strict 4-phase pipeline (A → B → C → D); phases complete in order

Both Claude Agent SDK (in-process) and opencode (HTTP MCP, subprocess) paths share in-process MCP tool handlers and must exhibit identical externally-observable behavior.

### Real-Time Updates

WebSocket hub broadcasts `prs:updated`, `repos:updated`, `walkthrough:updated`, `walkthrough:edited`, etc. Clients authenticate via `?token=` query param. Shape is `{ type, data? }` with `namespace:action` type strings — source of truth in `packages/shared/src/ws.ts`.

### Database

SQLite via Drizzle ORM. Schema in `apps/server/src/db/schema.ts` — applied directly on startup, no migration runner. To reset: `make reset-db`.

## TypeScript

All packages extend `tsconfig.base.json` with `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`. Don't suppress errors with `as` casts unless unavoidable.

## API

Key endpoints (all data routes require `Authorization: Bearer <token>`):

**Auth (device-code flow)**
- `POST /api/auth/device/init` — Start device flow; returns `device_code`, `user_code`, `verification_uri`
- `POST /api/auth/device/poll` — Exchange an approved `device_code` for a session token

**Data**
- `GET /api/prs` — List pull requests
- `GET /api/repos` — List repositories
- `POST /api/reviews` — Create or update review session
- `GET /api/reviews/:id` — Fetch review

WebSocket at `ws://localhost:45678` authenticates via `?token=<session-token>`.

## Troubleshooting

### `Failed to start sign-in: TypeError: Load failed`

The desktop app can't reach the local API server.

```bash
curl http://localhost:45678/       # 404 on / is fine — any response means running
launchctl list | grep revv         # PID in column 1 means running; - means crashed
revv logs                          # tail ~/Library/Logs/Revv/server.{out,err}.log
```

### `Failed to start sign-in: Error: Failed to initiate sign-in`

Server is reachable but GitHub returned an error. Common causes:

- **Device Flow not enabled** — go to `github.com/settings/developers` → your app → enable Device Flow → Update application
- **Invalid `client_id`** — typo or non-existent OAuth App

## Roadmap

See [`docs/prds/`](docs/prds/) for the full product roadmap.

| PRD | Title | Status |
|-----|-------|--------|
| 01 | Comment Persistence & Review Sessions | Shipped (~95%) |
| 02 | Chat Agent | Shipped core · polish partial |
| 03 | AI Guided Walkthrough | Shipped (~95%) |
| 04 | GitHub Sync & Conversations | Backend shipped · frontend ~50% |
| 05 | Chat-Driven Changes | Shipped core · polish partial |
| 06 | Polish, Performance & Ship | Partial (~50%) |

## Contributing

1. Create a feature branch
2. Make changes and test with `make dev`
3. Run `make typecheck` and `make lint` before committing
4. Open a pull request against `main`

## License

MIT
