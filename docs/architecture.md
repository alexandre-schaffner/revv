# Revv Architecture

Revv is a local-first review application with three runtime surfaces:

- `apps/web` is the SvelteKit UI hosted by Tauri in production and Vite in development.
- `apps/server` is the local Elysia API, SQLite journal, GitHub sync engine, and AI orchestration owner.
- `apps/desktop` is the Tauri shell that owns the desktop window, deep-link bridge, and local server process.

The server ships inside the app. `tauri build` runs `apps/server/scripts/build-binary.ts`, which compiles the server with `bun build --compile` for the target architecture into `Revv.app/Contents/MacOS/revv-server`. Migrations and `integrations/` are embedded in the binary, and the build commit is baked in and reported by `/api/health`. An in-app update therefore replaces the app and its server together; they cannot drift apart. The source checkout at `~/Library/Application Support/Revv/src` is only used by the `revv` CLI and local-build fallbacks.

The desktop app launches that binary directly, waits for `/api/health`, and restarts unexpected server exits up to three times per app run. Because the app spawns it, macOS attributes the server and everything it runs (`git`, `ssh`, agents) to Revv, which is the name permission prompts such as 1Password's show. Closing the window hides it to the tray. Quitting or relaunching the app stops the server and its process group. The server also watches its desktop parent so a force-quit triggers shutdown.

Environment overrides live in `~/Library/Application Support/Revv/desktop-server.json`. Its `executable` and `projectRoot` fields are only kept for older app versions; the checkout, when present, remains the server's working directory. The app migrates the old `com.revv.server` LaunchAgent configuration on first launch and removes the independent service. Development uses the separate server started by `make dev`, which runs from source.

The server is organized around deep modules: each public interface should be the narrow neck
that hides provider details, GitHub mechanics, persistence shape, and transport quirks.

## Module Map

```text
Feature modules        Walkthrough        Chat        Recaps        Merge-conflict
                            \               |             /
Agent substrate        job kernel       AI Providers      MCP Tool Gateway
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

Every agent is an ACP (Agent Client Protocol) subprocess; `ai/acp/run-turn.ts` runs one turn and
`ai/acp/agents/` holds one adapter per agent (how model and effort reach it, its auth probe, its
environment). `AiService` exposes the operations the product needs: `walkthroughTurn`, `chat`,
`resolveMergeConflict` and `isConfigured`. Provider selection is read through
`SettingsService.resolveAgent()`; provider-specific assembly stays inside the AI layer.

### Job Kernel

`makeAgentJobs` (`services/jobs/agent-jobs.ts`) is the one kernel every durable agent pipeline
(walkthrough, project recap, stack brief) runs on: the registry of live runs, the concurrency
budget, launch, Stop, resume-on-boot and how a run ends. Each orchestrator (`WalkthroughJobs`,
`ProjectRecapJobs`, `StackBriefJobs`) supplies its journal reads and writes, its phases and its
completion check. The journal row is the job.

### MCP Tool Gateway

Agent content reaches SQLite through MCP tool handlers, served over HTTP by the `routes/mcp/`
routes (one per pipeline, plus chat and the external coding agents) and authenticated with a
per-run bearer token. Each tool validates raw input at the boundary and performs one atomic
idempotent write.

### PR Context

`PrContextService` is the PR-scoped context seam. Walkthrough, Chat, Recap and stack code consume
PR, repository, metadata, and diff context from it, plus the `GitHubClient` for the repository's
owning account, which they pass to `GitHubGateway`. They never import `RepositoryService` or
`GitHubAccounts`, and never mint a client of their own.

### Settings

`SettingsService` owns settings persistence, normalization, change streams, and effective agent
selection. Feature code asks for `resolveAgent()` or `resolveRecapAgent()` instead of duplicating
agent-choice fallback rules.

### Platform Modules

Repos/GitHub hides API calls, retries, sync watermarks, and metadata persistence. Identity/Tokens
(`GitHubAccounts`) hides OAuth account resolution, token refresh, and the re-auth flag
(`account.reauth_required_at`, which it alone writes).

#### Realtime / Events

`Realtime` (`services/Realtime.ts`) is the realtime narrow neck for the global SSE stream
(`GET /api/events`). Features address a push to an account: `toAccount(accountId, msg)`, or
`toRepo(repoId, msg)` / `toPr(prId, msg)`, which resolve the owning account in one place.
`toAll(msg)` reaches every connected client and is reserved for server-global sync signals.
`Broadcaster` is the transport underneath (`register` per account from `routes/events.ts`, fan-out,
disconnect bookkeeping); only `Realtime`, `AppLayer` and the events route may import it
(`check:import-boundaries`). The envelope union (`ServerEventMessage`) lives entirely in
`@revv/shared/src/events`, so the wire contract has one source of truth.

Doctrine: **commit-first, broadcast-second** (invariant #8). Callers MUST commit to SQLite before
sending; a missed push is reconstructible from the DB on reconnect via the snapshot REST
endpoints. The interface carries no sequence cursor: the walkthrough emitter bumps the durable
`seq` and stamps it onto the envelope before sending.
Every feature-level event is account-scoped, including the PR sync's `prs:sync-started` /
`prs:sync-complete` / `prs:sync-failed`; `toAll` has no callers today.

PR / repo / auth / thread / chat / recap envelopes all flow through this same SSE channel.
Client-initiated sync requests are REST commands.

#### Local Git

`services/git/` is the only code that runs git. Its runner (`runner.ts`, private to the
directory) gives every command one policy: no prompts, none of the user's hooks, commit
signing per `GitPolicy` (the user's own config for commits pushed to their branches, off
otherwise), a timeout, the process registry the shutdown reaper kills, and token redaction. `ops.ts`
is the command surface; `remote.ts` builds the authenticated remote URL; `push.ts` pushes and
reads push failures; `scratch.ts` is the detached scratch worktree base sync and stack rebase run
in; `pr-refs.ts` names every ref, branch and worktree Revv creates; `BranchPushLock` allows one
push per remote branch. Revv never runs `git worktree prune` (the clone may be the user's
repository) and never moves a user's branch by name.

`RepoCloneService` owns clones, the per-PR agent worktree (`acquirePrWorktree`), the per-job
review worktree (`acquireReviewWorktree`) and file reads at a SHA. `PrWorkspace`
(`services/workspace/`) owns the agent worktree's use: one claim per PR shared by chat turns,
pushes and commit edits, the PR's chat session, and every operation on the agent's commits.
This module is distinct from `GitHubGateway`, which only talks to the GitHub API and never
touches the local filesystem.

## Import Direction

Feature modules depend inward on platform seams:

- Walkthrough, Chat, Recap and stack pipelines use `PrContextService` for PR-scoped GitHub
  context and call `GitHubGateway` only with its client; they do not import `RepositoryService`
  or `GitHubAccounts`.
- Only `services/github/` sends requests to GitHub (`services/github/transport`); everything else
  calls `GitHubGateway` with a client minted by `GitHubAccounts` or `PrContextService`.
- Provider selection comes from `SettingsService`, not from AI-provider helpers.
- Agent content writes go through MCP tool handlers; orchestrators own lifecycle/status writes.
- Routes resolve account context through `GitHubAccounts`, not `SecretStore` directly.
- Only `services/git/` spawns git, through its runner; everything else calls `services/git/ops`
  (or `RepoCloneService` / `PrWorkspace` for worktrees).
- Features send realtime pushes through `Realtime`, never `Broadcaster`.
- A multi-file feature keeps its files in `services/<feature>/` (conventions §2.7).

`bun run check:import-boundaries` enforces the PR-context, secret-store, GitHub-transport,
Local-Git and Broadcaster import rules.
