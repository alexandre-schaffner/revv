# PRD-03: AI Guided Walkthrough

## Status: **SHIPPED (~95%)**
## Priority: P1 (Core AI experience)
## Dependencies: PRD-01 (review sessions own the walkthrough)
## Original estimate: 5-6 days  |  Actual: in flight throughout the project
## Last updated: 2026-05-16

---

## Objective

Generate an AI-authored "guided tour" of a PR, anchored to its head SHA, presented as a structured sequence of conceptual chapters (each with markdown narrative + code/diff blocks), a 9-axis rating scorecard, an overall sentiment, and a set of flagged issues that can be turned into review comments. Reviewers navigate the walkthrough, comment on its blocks, edit it via the chat agent, and submit selected issues back to GitHub.

This PRD was substantially rebuilt during development. The original spec described a single `walkthroughs` table with a JSON `steps` column and a one-shot SSE stream. Reality is a strict 4-phase MCP-driven pipeline with five tables, two interchangeable agent transports, an orchestrator, supersession on new commits, resume-on-boot, and a post-completion chat-edit surface.

---

## Architecture overview

The walkthrough subsystem is governed by the "Agent Subsystem Invariants" section in [CLAUDE.md](../../CLAUDE.md). That section is canonical — this PRD describes the implementation; the invariants describe the contract. Anything that conflicts with CLAUDE.md is a bug in this PRD.

Key invariants worth re-stating:

- **SQLite is authoritative.** In-memory state is a reconstructible cache. Correctness survives `kill -9` at any instruction.
- **Agent content writes go through MCP tools, only.** Orchestrator lifecycle writes stay in Elysia.
- **Each MCP tool call is one atomic idempotent write** keyed on a deterministic identity.
- **Content generation is a strict 4-phase pipeline: A → B → C → D.** Out-of-order calls fail fast.
- **Walkthroughs are immutable per head SHA during generation.** A new commit supersedes (it doesn't mutate). The chat-edit path is the single authorized post-completion mutation channel.
- **Agent-path parity.** Both Claude Agent SDK and opencode produce byte-for-byte identical externally-observable behavior; only reasoning style differs.

### The 4-phase pipeline

| Phase | Purpose | Tool(s) | Writes to | Closes when |
|---|---|---|---|---|
| **A** | Overview + risk | `set_overview` | `walkthroughs.summary`, `walkthroughs.riskLevel` | One call lands |
| **B** | Diff analysis | `add_semantic_step`, `add_diff_step`, `flag_issue`, `add_issue_comment` | `walkthrough_semantic_steps`, `walkthrough_blocks`, `walkthrough_issues`, optionally `comment_threads`/`thread_messages` | Implicitly, when Phase C opens |
| **C** | Overall sentiment | `set_sentiment` | `walkthroughs.sentiment` | One call lands |
| **D** | 9-axis rating | `rate_axis` (×9) | `walkthrough_ratings` | All 9 axes rated |
| **Gate** | Validation | `complete_walkthrough` | Sets `status = 'complete'` | Asserts D complete, summary + sentiment non-empty, ≥1 diff step, every semantic step has ≥1 block, every blocking issue has an inline comment |

A read tool (`get_walkthrough_state`) is called first on every run — including resumes — to reconstruct the agent's context from DB rather than env vars.

The 9 axes (canonical render order, defined in `packages/shared/src/walkthrough.ts`):
`correctness · scope · tests · clarity · safety · consistency · api_changes · performance · description`

---

## Implementation

### Data model (`apps/server/src/db/schema/`)

- `walkthroughs.ts` — header row: status, `lastCompletedPhase`, `prHeadSha`, supersession back-reference, resume counter, summary, sentiment, risk level, `lastEditedAt` / `lastEditedBy`, `opencodeSessionId` for continuation
- `walkthrough-semantic-steps.ts` — chapters (Phase B); deterministically keyed on `(walkthrough_id, semantic_step_index)`
- `walkthrough-blocks.ts` — atomic markdown / code / diff blocks; keyed on `(walkthrough_id, semantic_step_id, step_index)`
- `walkthrough-issues.ts` — flagged issues with severity, status, optional inline comment thread, optional GitHub submission state
- `walkthrough-ratings.ts` — 9-axis scorecard, one row per axis, keyed on `(walkthrough_id, axis)` with `onConflictDoUpdate`

### MCP tool surface (`apps/server/src/ai/providers/walkthrough-tools/`)

Phase-bound write tools (one atomic upsert per call, deterministic key, phase precondition enforced inside `db.transaction()`):

- `set_overview` (Phase A, one call)
- `add_semantic_step`, `add_diff_step`, `flag_issue`, `add_issue_comment` (Phase B, many)
- `set_sentiment` (Phase C, one call — implicitly closes Phase B)
- `rate_axis` (Phase D, exactly 9)
- `complete_walkthrough` (validation gate — only the orchestrator transitions status)

Read tools:

- `get_walkthrough_state` — context reconstruction on every run/resume

Chat-edit tools (post-completion mutation, see `apps/server/src/ai/providers/chat-edit-tools/`):

- `update_overview`, `add_block`, `update_block`, `delete_block`, `add_semantic_step`, `update_semantic_step`, `delete_semantic_step`, `update_sentiment`, `update_rating`, `delete_rating`, `add_issue`, `update_issue`, `delete_issue`, `add_issue_comment`, `update_issue_comment`, `delete_issue_comment`

Edits stamp `lastEditedAt` / `lastEditedBy` on the parent row, never change `status` / `lastCompletedPhase`, and broadcast `walkthrough:edited` envelopes via `WebSocketHub` (not the generation SSE stream — that dies on `done`). GitHub-submitted issues (`submittedAt != null`) are off-limits even here.

### Dual agent transport

Tool **handlers** are shared in-process code. Tool **transport** differs:

- **Claude Agent SDK path** — `apps/server/src/ai/providers/mcp-walkthrough.ts` registers handlers in-process with the SDK
- **Opencode path** — `apps/server/src/routes/mcp/walkthrough.ts` exposes the same handlers over HTTP; the opencode subprocess connects to it using a short-lived token from `ChatMcpTokens`

Supervision via `apps/server/src/services/OpencodeSupervisor.ts`: lazy-starts the `opencode serve` subprocess when the selected agent is opencode and an active job needs it; stops it when idle or when the selected agent changes. Credentials and bound port are ephemeral.

### Orchestrator (`apps/server/src/services/WalkthroughJobs.ts`, `apps/server/src/services/Walkthrough.ts`)

`WalkthroughJobs` owns lifecycle: schedules jobs, enforces `MAX_CONCURRENT_JOBS = 5` via semaphore, manages per-job worktrees registered as scope finalizers, runs resume-on-boot, advances `status ∈ {generating, complete, error, superseded}` (agents never write status). Bounded retries: `WALKTHROUGH_MAX_RESUME_ATTEMPTS = 3`, `MAX_AUTO_CONTINUATIONS = 2`.

On a new PR head SHA, the old walkthrough is marked `superseded` with a `superseded_by` back-reference and a fresh row begins generating — the 4-phase pipeline never mutates a row for the same head SHA.

### Streaming endpoint (`apps/server/src/routes/reviews/handlers/walkthrough-stream.ts`)

- `GET /api/reviews/:id/walkthrough` — SSE stream of `WalkthroughStreamEvent` envelopes (`apps/server/src/routes/reviews/sse.ts`). Serves from cache when the head SHA matches; otherwise dispatches a job and streams its events.
- `POST /api/reviews/:id/walkthrough/regenerate` — supersede + restart
- `POST /api/reviews/:id/walkthrough/resume` — re-attach to an in-flight job

Commit-first / broadcast-second: every event is emitted from a tool handler **after** the DB transaction commits, so SSE / WebSocket subscribers can always reconcile by re-reading the DB. Post-completion mutations broadcast on the separate `walkthrough:edited` WebSocket channel (the generation SSE stream dies on `done`).

### Frontend (`apps/web/src/lib/`)

Components (`components/walkthrough/`):

- `GuidedWalkthrough.svelte` — top-level container; phase-aware rendering
- `WalkthroughSection.svelte` — one semantic step (chapter)
- `WalkthroughMarkdownBlock.svelte`, `WalkthroughCodeBlock.svelte`, `WalkthroughDiffBlock.svelte` — the three block kinds
- `IssueCard.svelte` — Phase B issue with severity badge and inline comment thread
- `WalkthroughRatingsGrid.svelte`, `WalkthroughRatingsPanel.svelte`, `ratings-panel/` — Phase D scorecard
- `components/review/issues-panel/`, `comments-panel/` — sibling summary panels

Stores (`stores/`):

- `walkthrough.svelte.ts` — reactive walkthrough state hydrated from DB
- `walkthrough-stream.svelte.ts` — SSE + WebSocket subscription, reconciliation on reconnect
- `walkthroughNav.svelte.ts` — keyboard navigation between sections

The PR review page (`apps/web/src/routes/review/[prId]/+page.svelte`) and `FloatingTabs.svelte` toggle between the walkthrough and the file-diff view.

### WebSocket envelopes (`packages/shared/src/ws.ts`)

Generation events: `walkthrough:event` (proxies `WalkthroughStreamEvent` after generation SSE ends), plus per-event types defined in `packages/shared/src/walkthrough.ts`.
Post-completion edits: `walkthrough:edited`.

---

## Remaining gaps

- [ ] **Step-level regenerate.** `POST /api/reviews/:id/walkthrough/steps/:index/regenerate` exists in spirit but not as a dedicated endpoint — currently the chat agent's edit tools cover the use case at finer granularity; decide whether to formalize the older endpoint or remove it from the roadmap
- [ ] **Click code block → jump to diff view.** Architecturally supported (block carries `file_path` + line range); the navigation hand-off has rough edges around scroll-into-view timing on large files
- [ ] **Keyboard navigation polish.** Arrow-key navigation works inside `walkthroughNav.svelte.ts` but doesn't yet integrate with the diff-tab keymap (see PRD-06 remaining shortcuts)
- [ ] **Empty / error states.** Generation failure surfaces an inline error but no dedicated "what now" affordance (manual resume vs supersede vs report)
- [ ] **Token / cost surfacing.** No visible token-usage indicator at the walkthrough level (we track it server-side but don't render it)
- [ ] **Re-running on a closed PR.** Supersession assumes there will be a future head SHA; closed PRs work but the UI doesn't make clear that no further generation will happen

---

## Cross-references

- **CLAUDE.md, "Agent Subsystem Invariants"** — canonical contract
- **PRD-02 (Chat Agent)** — shares the MCP infrastructure, opencode supervisor, and dual-transport pattern; chat-edit tools live in PRD-02's surface but write to walkthrough tables
- **PRD-04 (GitHub Sync)** — issue submission writes back to GitHub via the sync service; `submittedAt != null` makes an issue immutable
- **07-emergent-features.md** — index of features that emerged outside the original roadmap

---

## Acceptance criteria (delta only — shipped items not re-listed)

- [ ] Generating a walkthrough for a PR with a new head SHA always produces a fresh row and supersedes the old; the old row's `status` is `superseded` and `superseded_by` points to the new one
- [ ] `kill -9` of the server during Phase B leaves the DB in a recoverable state; on boot, `WalkthroughJobs.resumeOnBoot` reschedules and `get_walkthrough_state` lets the agent pick up where it left off
- [ ] Switching agents (Claude ↔ opencode) mid-pipeline does not produce visibly different `WalkthroughStreamEvent` sequences for the same input
- [ ] Chat-edit mutations broadcast on `walkthrough:edited` and never on the generation SSE stream
- [ ] Submitted issues (`submittedAt != null`) reject mutation attempts from chat-edit tools
- [ ] `make typecheck` and `make lint` pass
