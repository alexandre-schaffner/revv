# Revv Architecture Review

## Overall Assessment: Ambitious and mostly well-architected, with a few structural risks

---

## What's Strong

**Effect system on the server** is the right call for this domain. The typed error channel, structured concurrency, and `Layer`-based DI eliminate whole classes of bugs — no silent unhandled exceptions, no "who forgot to provide this service," no leaked worktrees. The dependency graph in `AppLayer.ts` is explicit and compile-time verified.

**The agent pipeline invariants** are well thought-out. The 4-phase A→B→C→D structure, immutable walkthroughs per head SHA, MCP as the sole write gateway, and "commit before broadcast" — these aren't just good practice, they're explicitly encoded as schema constraints and phase preconditions. Crash safety is treated as a first-class property, not an afterthought.

**Eden treaty** for end-to-end type safety is a nice fit here. The frontend gets fully type-checked API calls with no schema duplication step, and the Elysia route definitions become the single source of truth for the contract.

**Dual agent path with shared MCP handlers** solves the right problem. Enforcing parity via shared in-process handler code rather than hoping two independent implementations stay in sync is the correct architectural choice.

---

## Architecture Overview

### Monorepo Layout

```
apps/web        SvelteKit frontend (Tauri webview + localhost:5173 in dev)
apps/server     Bun/Elysia HTTP + WebSocket server (port 45678)
apps/desktop    Tauri v2 shell (minimal Rust: window, tray, deep-link, updater)
packages/shared Cross-app types, WS schemas, constants
```

### Server Layer

The server uses the [Effect](https://effect.website/) library pervasively. Every service is a `Context.Tag` + `Layer`, composed through `Layer.provide` / `Layer.mergeAll`. Dependency injection is compile-time typed via the `Effect<A, E, R>` `R` parameter; errors are typed via the `E` channel.

**Key services:** `WalkthroughJobs`, `PollScheduler`, `WebSocketHub`, `SettingsService`, `OpencodeSupervisor`, `ChatSessionService`, `RepoCloneService`, `SyncService`, `AiService`.

**Database:** Drizzle ORM on SQLite. 25 tables. All timestamps stored as ISO 8601 text. JSON arrays/objects stored as text columns. No migration runner — schema applied directly on boot.

**`WalkthroughJobs`** is the most complex service:
- In-memory `Map<walkthroughId, ActiveJob>` registry (reconstructed from DB on restart via `resumePending`)
- Global `Semaphore(5)` caps concurrent AI generation fibers
- Per-PR serialization mutex prevents duplicate fiber spawns
- Each job acquires a scoped git worktree at `pr_head_sha` with an Effect finalizer for cleanup
- `setStatus` is the **sole writer** of `walkthroughs.status` (invariant #11)
- Auto-continuation: up to 2 retries if the agent exits before Phase D

### Agent Pipeline

Two agent paths, both surfaced through the same `AiService.streamWalkthrough()` interface:

1. **Claude Agent SDK** — in-process MCP server; tool handlers called synchronously within the Bun process
2. **Opencode** — calls the `opencode serve` HTTP daemon; tools served over `/mcp/walkthrough`

Both paths share the same MCP tool handler implementations, satisfying the agent-path parity invariant.

**MCP tool surface (write-only path for walkthrough content):**

| Tool | Phase | What it does |
|---|---|---|
| `get_walkthrough_state` | read | Agent reconstructs context from DB on every run start |
| `set_overview` | A | Writes summary + risk_level, advances phase to 'A' |
| `add_semantic_step` | B | Opens a new chapter with title, summary, and first block |
| `add_diff_step` | B | Adds a subsequent block to an existing chapter |
| `flag_issue` | B | Flags a structured concern |
| `add_issue_comment` | B | Creates an inline diff comment thread |
| `set_sentiment` | C | Writes the overall sentiment paragraph |
| `rate_axis` | D | Rates one of 9 axes; all 9 required to complete Phase D |
| `complete_walkthrough` | gate | Validates all invariants; orchestrator transitions status to 'complete' |

### Frontend Layer

**API client:** Eden treaty — `treaty<App>()` creates a fully type-safe client from the server's exported `App` type. No manual schema definitions.

**Stores (Svelte 5 runes):** `$state` / `$derived` / `$effect` in `.svelte.ts` files. Named getter/setter functions, not subscribables.

- `walkthrough.svelte.ts` — SSE streaming, hydration from REST, WS mutation application, all walkthrough display state (~1545 lines)
- `ws.svelte.ts` — WebSocket connection with exponential backoff reconnect; exhaustive switch on `WsServerMessage.type`
- `prs.svelte.ts` — PR list with fuzzy search, grouping, and derived views
- `review.svelte.ts` — diff files, comment threads, per-PR scroll positions

**Motion:** Tailwind CSS v4 with custom timing utilities (`duration-snap`, `duration-quick`, `duration-smooth`, `ease-out-expo`). Global `@media (prefers-reduced-motion)` collapses all transitions to ~1ms; motion-essential elements opt back in via `.motion-essential-*`.

### Desktop Layer

Minimal Rust (~130 lines). Key behaviors: system tray (close hides, doesn't quit), single-instance guard, `revv://` deep-link for OAuth callback, autostart with `--hidden`, passive background updater.

---

## Risks and Weaknesses

### 1. No Migration Runner — Biggest Technical Debt

Applying schema directly with `createTableIfNotExists` works during development but is a time bomb for production. The first time a released version needs a non-trivial schema change (add a NOT NULL column, rename something, change an index), existing user DBs either break or require a bespoke one-off script. The "stored now so migrations don't need to change" comments already visible in the schema show the workaround pattern starting to emerge. Drizzle has a migration system — it should be used before users accumulate data.

### 2. `walkthrough.svelte.ts` is a Maintenance Liability

At ~1545 lines, this file conflates transport concerns (SSE streaming, WS mutation application) with domain state (phases, blocks, issues, ratings) and hydration logic. As the chat-edit path and generation path diverge in their invalidation needs, this file will become increasingly difficult to reason about. It should be split — at minimum, separating streaming/transport from display state.

### 3. Single-User Assumption Baked In

The `settings.json` singleton, `id: "default"` user, and the lack of user scoping in `WalkthroughJobs` mean multi-user support would require a significant rework rather than an incremental addition. This is fine if it's a conscious product decision, but it should be explicit.

### 4. `OpencodeSupervisor` Crash-Loop Window Resets on Server Restart

The 60-second rolling crash-loop window is tracked in memory. A server restart resets the counter, so a persistently broken opencode daemon gets 3 free retry attempts on every server restart rather than hitting a terminal error state. This can cause repeated startup noise without a clean failure mode.

### 5. WebSocket Hub Has No Message Queue

The design correctly requires clients to reconcile from the DB on reconnect, and the WS store does this. But it's an implicit contract that every future WS consumer must also uphold. A missed `walkthrough:complete` during a brief disconnect requires a round-trip re-fetch to recover. This adds cognitive load on every new feature that introduces WS events.

---

## Bottom Line

The core infrastructure choices — Effect for the server, Svelte 5 runes, immutable walkthrough records, MCP as the sole write gateway — are sound. The architecture has been designed with crash safety and agent-path parity as first-class properties, which is unusually disciplined.

The migration story needs to be fixed before real users accumulate data. The walkthrough store will need splitting as the feature set grows. Everything else is manageable with discipline.
