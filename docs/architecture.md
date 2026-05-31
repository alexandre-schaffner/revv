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
hides OAuth account resolution and token refresh. Local Git hides clone/worktree management.
Realtime/Events hides best-effort broadcast mechanics and keeps the DB as the reconciliation
source.

## Import Direction

Feature modules depend inward on platform seams:

- Walkthrough, Chat, and Recap use `PrContextService` for PR-scoped GitHub context.
- Feature modules do not import `GitHubService`, `RepositoryService`, or `TokenProvider` directly.
- Provider selection comes from `SettingsService`, not from AI-provider helpers.
- Agent content writes go through MCP tool handlers; orchestrators own lifecycle/status writes.

`bun run check:import-boundaries` enforces the current PR-context import rule and names the
remaining legacy exceptions scheduled for later waves.
