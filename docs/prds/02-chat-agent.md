# PRD-02: Chat Agent

## Status: **SHIPPED (core) + PARTIAL polish**
## Priority: P0 (Primary AI surface)
## Dependencies: PRD-01 (persisted threads anchor the agent's context)
## Original PRD-02 scope: A streaming "explain this code" panel. **Abandoned in favor of a full chat agent.**
## Last updated: 2026-05-16

---

## Objective

Provide a persistent, conversational AI surface — anchored to a PR review session — that can read repo state, propose code changes, run a plan-mode loop, ask clarifying questions, and stream tool use to the reviewer in real time. The chat agent is the entry point for every AI interaction in the app: explanations, edits, walkthrough refinement, and post-review proposals (PRD-05) all live inside this surface.

This PRD replaces the original "AI Context Panel" spec. The original line-click `Explain` flow was never built; the use case was absorbed into the chat agent (the reviewer simply asks).

---

## What we built

### Services (`apps/server/src/services/`)

- **`Ai.ts`** — `AiService` is the agent driver. Resolves the configured agent (`claude` or `opencode`), streams `ChatStreamFrame` events, exposes `resolveMergeConflict` for the push flow (see PRD-05), and dispatches MCP tool calls to in-process handlers.
- **`ChatSession.ts`** — `ChatSessionService` owns the per-PR chat session lifecycle: worktree path, head SHA, branch name (`pr-{N}`), interaction mode (chat / plan), pending question state, last-seen activity timestamp. Sessions are persistent across app restarts.
- **`ChatChangesPush.ts`** — git operations (commit, merge into source branch, `--force-with-lease` push, conflict detection, per-PR locking). Documented in PRD-05.
- **`ChatMcpTokens.ts`** — issues short-lived bearer tokens that the opencode subprocess uses to authenticate back into the server's MCP HTTP endpoints.
- **`OpencodeSupervisor.ts`** — lazy-starts `opencode serve` only when the selected agent is opencode and an active job needs it; stops it when idle or when the selected agent changes. Credentials and bound port are ephemeral.

### Routes (`apps/server/src/routes/`)

- `chat.ts` — top-level mount and SSE message-stream endpoint
- `chat-route-interactions.ts` — plan approval, question answering, queue manipulation
- `chat-route-proposed-changes.ts` — proposed-commits strip endpoints (see PRD-05)
- `chat-helpers.ts` — shared helpers for activity/task/plan rendering
- `mcp/chat-context.ts` — HTTP MCP endpoint serving read tools (repo state, threads, diff, walkthrough)
- `mcp/walkthrough.ts` — HTTP MCP endpoint for walkthrough generation tools (see PRD-03)

### MCP tool surface (`apps/server/src/ai/providers/`)

- **`chat-mcp-tools.ts`** — read-only tools the chat agent uses to ground its responses (repo files, diff, threads, walkthrough state, file content)
- **`chat-edit-tools/`** — write tools for editing a completed walkthrough (see PRD-03, "Chat-edit MCP surface")
- **`chat-claude.ts`** — Claude Agent SDK driver
- **`chat-opencode.ts`** — opencode HTTP driver (matches Claude path's streaming contract byte-for-byte; cf. CLAUDE.md "Agent-path parity")
- **`stream-guard.ts`** — connection-drop tolerance for long-running streams

### Schema (`apps/server/src/db/schema/`)

Chat state is persistent. Tables:

- `chat-sessions.ts` — one row per PR (worktree, branch, head SHA, agent, model, interaction mode, last activity)
- `chat-messages.ts` — full conversation history with role + serialized content blocks
- `chat-tasks.ts` — agent task list (plan-mode todo items)
- `chat-plans.ts` — plan-mode plan documents and approval state
- `chat-activities.ts` — fine-grained activity log (tool calls, thinking, status changes) — drives the streaming UI
- `chat-questions.ts` — pending questions the agent is blocked on
- `chat-subagent-invocations.ts` — recorded sub-agent calls for debugging

### Frontend (`apps/web/src/lib/`)

- `components/layout/RightPanel.svelte` — the chat surface itself
- `components/layout/AgentSelector.svelte`, `ModelSelector.svelte`, `ThinkingEffortSelector.svelte` — runtime agent/model controls
- `components/layout/StreamingVerb.svelte` — animated streaming indicator
- `components/ai/conversation/`, `message/`, `tool/`, `plan/`, `question/`, `queue/`, `confirmation/`, `checkpoint/`, `prompt-input/`, `shimmer/`, `suggestion/`, `context/` — message/tool-use rendering, plan UI, queue, confirmations
- `stores/chat.svelte.ts` — chat state (messages, activities, tasks, plan, pending questions, streaming status, proposed commits)
- `stores/ws.svelte.ts` — connection management

### Settings location

The original PRD assumed `user_settings` would store the API key. That table was dropped (see `apps/server/src/db/schema/index.ts`); preferences now live in `~/.revv/settings.json` via `SettingsService`. Agent credentials follow each agent's own conventions — no API key entry field in the Revv UI.

---

## Architecture notes

The chat agent observes the same invariants as the walkthrough subsystem (see CLAUDE.md "Agent Subsystem Invariants"):

- **SQLite is authoritative.** In-memory chat state is reconstructible from `chat_sessions` + `chat_messages` + `chat_activities` on every reload.
- **Agent content writes go through MCP, only.** Chat-edit tools write to walkthrough tables; lifecycle writes (status, head SHA) stay on the server side.
- **Per-job resource scoping.** Each chat session owns a dedicated git worktree at the PR head SHA, registered as a scope finalizer so cleanup happens on every exit path.
- **Agent-path parity.** Claude Agent SDK and opencode produce byte-for-byte identical externally-observable events for the same conversation; only the model's reasoning style differs.

The chat agent does **not** generate walkthroughs (that's PRD-03's pipeline) and does **not** persist its own proposed-commit state in a dedicated table — proposed commits are real git commits on the `pr-{N}` worktree branch, queried via `git log` on demand (see PRD-05).

---

## Remaining gaps

Polish items, in rough priority order:

- [ ] **Cheat-sheet for chat shortcuts** — `?` overlay listing chat-specific keys (currently no centralized reference)
- [ ] **Input-focus guards on global shortcuts** — currently shortcuts can fire while typing in chat input
- [ ] **Plan-mode resume-on-boot edge cases** — confirm that a chat session interrupted mid-plan-approval restores cleanly
- [ ] **Recovery UX for opencode subprocess crash** — supervisor restarts, but the chat surface needs a "reconnecting…" indicator that doesn't look like the model is just slow
- [ ] **Per-message regenerate** — chat history shows past turns but no "regenerate from here" affordance
- [ ] **Token / context budget surfacing** — no visible context-window usage indicator
- [ ] **Conversation export** — no "copy as markdown" or "share session" path

---

## Acceptance criteria (delta only — shipped items not re-listed)

- [ ] Reduced-motion: streaming indicator opts back in with `motion-essential-*` class (per CLAUDE.md UI conventions); cheat-sheet overlay respects `prefers-reduced-motion`
- [ ] Opening a PR with an existing chat session restores conversation + plan + queue + pending question state without flicker
- [ ] Switching agents (Claude ↔ opencode) mid-session does not corrupt history; supervisor lifecycle obeys "lazy-start, stop when idle"
- [ ] `make typecheck` and `make lint` pass
