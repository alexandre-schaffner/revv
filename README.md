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

**Recommended — one-command installer:**

```bash
curl -fsSL https://github.com/alexandre-schaffner/revv/releases/latest/download/install.sh | bash
```

The installer:

1. Verifies its own Sigstore attestation (requires `gh` CLI or auto-bootstraps `cosign`)
2. Installs the pre-built `Revv.app` for your architecture
3. Installs the local API server LaunchAgent on `http://localhost:45678`
4. Installs the `revv` management CLI

**Requires macOS 10.15 (Catalina) or later.**

> **Note:** macOS Gatekeeper will show an "unidentified developer" warning until Apple
> Developer ID code-signing is complete. To open: right-click `Revv.app` → **Open**, then
> click **Open** in the dialog. This is a known limitation — Authenticode/notarization is
> tracked as a follow-up.

#### Verifying the installer

Before piping to bash, you can verify the release installer's Sigstore attestation manually:

```bash
curl -fsSL https://github.com/alexandre-schaffner/revv/releases/latest/download/install.sh -o install.sh
gh attestation verify install.sh --repo alexandre-schaffner/revv
bash install.sh
```

To pin to a specific release tag:

```bash
curl -fsSL https://github.com/alexandre-schaffner/revv/releases/download/v0.1.0/install.sh | bash
```

#### Customizing the installer

| Variable | Default | Purpose |
|---|---|---|
| `REVV_AUTO_YES` | `0` | `1` skips every confirm prompt |
| `REVV_APP_DIR` | `/Applications` | Falls back to `~/Applications` if not writable |

#### Managing the install

```bash
revv status      # show install paths, versions, server state, update availability
revv update      # install channel bundle; rebuild only if no asset is available
revv restart     # restart the background API server
revv logs        # tail ~/Library/Logs/Revv/server.{out,err}.log
revv open        # launch Revv.app
revv uninstall   # remove app, source, LaunchAgent, and the CLI itself
```

---

### Windows

**Recommended — one-command installer:**

```powershell
irm https://github.com/alexandre-schaffner/revv/releases/latest/download/install.ps1 | iex
```

The installer:

1. Verifies its own Sigstore attestation (requires `gh` CLI)
2. Downloads the pre-built Revv MSI
3. Verifies the bundle SHA256 checksum
4. Runs `msiexec` to install

> **Note:** Windows SmartScreen may warn about the installer until Authenticode signing is
> complete. This is a known limitation — code-signing is tracked as a follow-up.

#### Verifying the installer

```powershell
Invoke-WebRequest -Uri https://github.com/alexandre-schaffner/revv/releases/latest/download/install.ps1 -OutFile install.ps1
gh attestation verify install.ps1 --repo alexandre-schaffner/revv
.\install.ps1
```

**Alternative — download the MSI or NSIS installer from [Releases](https://github.com/alexandre-schaffner/revv/releases)** and run it directly.

#### Customizing the installer

| Variable | Default | Purpose |
|---|---|---|
| `REVV_AUTO_YES` | `0` | `1` skips every confirm prompt |

#### Managing the install

```powershell
revv status      # show install paths, versions, server state, update availability
revv update      # git pull + rebuild + reinstall + reload service
revv restart     # restart the background API server
revv logs        # tail server logs
revv open        # launch Revv.exe
revv uninstall   # remove app, source, scheduled task, and the CLI itself
```

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

From a checkout, the quickest way to set up the full toolchain is:

```powershell
.\install.ps1 -Dev    # toolchain + deps only
```

Without a checkout yet (installs toolchain via a temp clone):

```powershell
irm https://github.com/alexandre-schaffner/revv/releases/latest/download/install.ps1 | iex -Args '-Dev'
```

### Setup

```bash
git clone https://github.com/alexandre-schaffner/revv.git
cd revv
bun install
cp .env.example .env   # fill in GITHUB_CLIENT_ID and BETTER_AUTH_SECRET
```

### Development

**macOS / Linux:**

```bash
make dev             # all 3 services (web @ 5173, server @ 45678, Tauri desktop)
make dev-web         # SvelteKit only
make dev-server      # Elysia API only
```

**Windows (PowerShell):**

```powershell
bun run dev          # all 3 services
bun run dev:web      # frontend only
bun run dev:server   # API only
```

### Quality & Build

**macOS / Linux:**

```bash
make typecheck       # tsc across all packages
make lint            # linters across all packages
make build           # build all packages
make dist            # build platform installer (dmg/msi/deb)
make clean           # remove build artifacts
make reset-db        # delete SQLite database
```

**Windows (PowerShell):**

```powershell
bun run typecheck    # tsc across all packages
bun run lint         # linters across all packages
bun run build        # build all packages
bun run dist         # build Tauri desktop bundle
bun run clean        # remove build artifacts
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
