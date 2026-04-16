# Rev

A desktop tool for interacting with your computer through CLI commands. You open Rev on a repository and it becomes a visual shell — every piece of UI is constructed by spawning processes and parsing their output.

## Vision

Rev is built on a single principle: **the CLI is the API**. Instead of reimplementing integrations or maintaining OAuth flows, Rev leverages the tools already installed and authenticated on your machine.

- **git** — The header initializes by running git commands. Status, branches, diffs, and logs are all live terminal output, persisted in the UI.
- **gh** — Pull requests, issues, checks, and reviews come straight from the GitHub CLI.
- **claude / opencode** — AI assistance through CLI spawning, not API keys.
- **gcloud / aws / kubectl** — Cloud context without re-authentication.
- **bun / node / npm** — Package management and script execution.
- **lsof / ps** — System introspection for port conflicts, running processes.

Every UI element maps to a command:
- **Read** = spawn a process, parse stdout, render rows.
- **Write** = a button click triggers another command.
- **Stream** = long-running processes feed live updates into the view.

### Architecture

At its core, Rev is a terminal emulator with a structured UI layer on top. The foundation is a process spawner — you can type any command and see its output. On top of that, specialized views parse CLI output into rich UI:

- A **git status header** initializes on repo open, runs git commands, and persists the parsed output.
- **Rows** are spawned from commands — e.g. `gh pr list` produces a table of PRs where each row is clickable.
- **Buttons** trigger commands — approve a PR, merge a branch, deploy a service.
- **Streaming views** attach to long-running processes for live output.

### Global Log

Every command Rev executes is captured in a global log — the command, its exit code, stdout, stderr, and timing. Full auditability. You can always see exactly what Rev did on your machine.

### Permission Manager

Rev controls which commands can be executed. The user has full visibility and can grant or revoke permissions per tool, per command pattern. Nothing runs without consent.

## Stack

Bun + TypeScript monorepo (Turborepo), React 19, TanStack Start, shadcn/ui, Electrobun.

## Monorepo Layout

| Path | Description |
|------|-------------|
| `packages/ui` | Shared React component library (shadcn/ui) |
| `packages/app` | TanStack Start frontend (port 3000) |
| `packages/shared` | Shared types and constants |
| `apps/desktop-electrobun` | Electrobun desktop shell |
| `apps/web` | SvelteKit frontend (legacy, port 5173) |
| `apps/server` | Elysia API server (port 45678) |
| `apps/desktop` | Tauri v2 desktop shell (legacy) |

## Setup

```bash
bun install
```

## Development

```bash
# New React desktop app
bun run dev:app              # TanStack Start frontend on port 3000
bun run dev:electrobun       # Frontend + Electrobun desktop shell

# Legacy Svelte desktop app
make dev                     # All legacy services (web, server, Tauri)
```

## Dependency Management

Shared dependency versions are managed via [Bun catalogs](https://bun.sh/docs/install/workspaces#catalogs) in the root `package.json`. Use `"catalog:"` in workspace packages to reference centralized versions.
