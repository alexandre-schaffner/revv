# Revv Architecture

Revv is a local-first review application with three runtime surfaces:

- `apps/web` is the SvelteKit UI hosted by Tauri in production and Vite in development.
- `apps/server` is the local Elysia API, SQLite journal, GitHub sync engine, and AI orchestration owner.
- `apps/desktop` is the Tauri shell that owns the desktop window and deep-link bridge.

The server is organized around deep modules: each public interface should be the narrow neck
that hides provider details, GitHub mechanics, persistence shape, and transport quirks.

## Module Map

```text
Feature modules        Walkthrough        Chat        Recaps        Merge-conflict
                            \               |             /
Agent substrate        job helpers      AI Providers      MCP Tool Gateway
                            \               |             /
Context seam                         PR Context
                            /               |             \
Platform modules       Repos/GitHub   Identity/Tokens   Local Git   Realtime/Events   Settings
                                              \          |          /
Foundation                              Db / Drizzle
```

## Narrow Necks

### Feature Modules

Walkthrough, Chat, Recaps, and Merge-conflict own user-facing workflows and lifecycle policy.
They should compose platform services through narrow interfaces rather than reaching through to
GitHub, token, repository, or daemon details.

### AI Providers

`AiService` exposes the three provider-shaped operations the product actually needs:
walkthrough streaming, chat streaming, and merge-conflict resolution. Provider selection is read
through `SettingsService.resolveAgent()`; provider-specific dependency assembly stays inside the
AI layer.

### Job Helpers

Shared job code should stay as small helpers for duplicated mechanics such as subscriber fan-out,
per-key start mutexes, failure verdicts, and session-token stores. Walkthrough and recap
orchestrators remain concrete because their lifecycle, phases, worktree ownership, and completion
semantics differ.

### MCP Tool Gateway

Agent content reaches SQLite through MCP tool handlers. Tool handlers are the shared gateway
between in-process SDK usage and HTTP daemon usage; each tool validates raw input at the boundary
and performs one atomic idempotent write.

### PR Context

`PrContextService` is the PR-scoped context seam. Walkthrough, Chat, and Recap code should consume
PR, repository, token, metadata, and diff context from this service instead of importing
`GitHubService`, `RepositoryService`, or `TokenProvider` directly.

### Settings

`SettingsService` owns settings persistence, normalization, change streams, and effective agent
selection. Feature code asks for `resolveAgent()` or `resolveRecapAgent()` instead of duplicating
agent-choice fallback rules.

### Platform Modules

Repos/GitHub hides API calls, retries, sync watermarks, and metadata persistence. Identity/Tokens
hides OAuth account resolution and token refresh.

#### Realtime / Events

`Broadcaster` is the realtime narrow neck for the global SSE stream (`GET /api/events`). Its
interface is tiny — `register` / `broadcast` / `broadcastToAccount` — and it hides best-effort
fan-out, SSE frame encoding, and disconnect bookkeeping. The envelope union (`ServerEventMessage`)
lives entirely in `@revv/shared/src/events`, never server-side, so the wire contract has one
source of truth.

Doctrine: **commit-first, broadcast-second** (invariant #8). The broadcaster is the broadcast
point — callers MUST commit to SQLite before broadcasting; a missed broadcast is reconstructible
from the DB on reconnect via the snapshot REST endpoints. The interface carries no sequence cursor:
the walkthrough emitter owns `bumpSeq` (durable wire cursor) and `nextSeq` (in-memory diagnostic)
and stamps `seq` onto the envelope before it reaches the broadcaster.

`WebSocketHub` is the legacy transport for the PR / repo / chat / new-PR-session WS envelopes
(union in `@revv/shared/src/ws`). Those channels migrate onto the `Broadcaster` SSE stream
incrementally in follow-up work; until then `WebSocketHub` follows the same best-effort,
account-scoped, commit-first doctrine.

#### Local Git

`RepoCloneService` is the Local Git neck: it hides repo clone, per-PR worktree acquisition
(`acquirePrWorktree`), and file reads at a SHA. `git-runner` (the raw git-subprocess primitive
with its process registry and signal handling) and `GitOps` (push primitives) are module
internals — only the Local Git module spawns git directly. Worktree acquisition stays scoped to
the acquiring job. This module is distinct from `GitHubGateway`, which only talks to the GitHub
API and never touches the local filesystem.

## Import Direction

Feature modules depend inward on platform seams:

- Walkthrough, Chat, and Recap use `PrContextService` for PR-scoped GitHub context.
- Feature modules do not import `GitHubService`, `RepositoryService`, or `TokenProvider` directly.
- Provider selection comes from `SettingsService`, not from AI-provider helpers.
- Agent content writes go through MCP tool handlers; orchestrators own lifecycle/status writes.
- Routes resolve account context through `Identity`, not `SecretStore` / `TokenProvider` directly.
- Only the Local Git module (`RepoCloneService`, `GitOps`) spawns git via `git-runner`; everything
  else goes through those seams.

`bun run check:import-boundaries` enforces the PR-context, Identity, and Local-Git import rules and
names the remaining legacy exceptions scheduled for later waves.
