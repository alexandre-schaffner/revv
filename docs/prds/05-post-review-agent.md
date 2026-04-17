# PRD-05: Post-Review Agent

## Priority: P1 (AI automation)

## Dependencies: PRD-01 (persisted threads), PRD-02 (AiService), PRD-03 (walkthrough context), PRD-04 (synced threads with GitHub IDs)

## Estimated: 5-6 days

---

## Objective

After a reviewer finishes commenting, they trigger an AI agent that collects all open threads, understands the reviewer's intent, and proposes concrete code changes. The output is a readable document — rationale + diffs, not a raw patch dump. Accepted changes push to the PR as GitHub suggestions or a fixup commit.

---

## Current State

By the time we reach this PRD, we'll have:

- Persisted threads with messages in SQLite (PRD-01)
- `AiService` with Claude integration and SSE streaming (PRD-02)
- Walkthrough summaries cached per PR (PRD-03)
- Threads synced with GitHub, with `external_thread_id` and `external_id` for mapping (PRD-04)
- Full file content in `fileContentCache` table
- Hunk accept/reject decisions per review session

---

## Data Model

### New Tables

```sql
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,                          -- UUID
  review_session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | collecting | analyzing | generating | completed | failed
  input_thread_ids TEXT NOT NULL,               -- JSON: string[] of thread IDs fed to the agent
  summary TEXT,                                 -- agent's overall summary (null until completed)
  error_message TEXT,                           -- populated on failure
  model_used TEXT NOT NULL,
  token_usage TEXT,                             -- JSON: { input: number, output: number }
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE proposed_changes (
  id TEXT PRIMARY KEY,                          -- UUID
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  original_content TEXT NOT NULL,               -- original code section
  proposed_content TEXT NOT NULL,               -- proposed replacement
  diff TEXT NOT NULL,                           -- unified diff of the change
  rationale TEXT NOT NULL,                      -- markdown: why this addresses the comments
  related_thread_ids TEXT NOT NULL,             -- JSON: string[] of thread IDs this addresses
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | accepted | rejected | edited
  edited_content TEXT,                          -- non-null if reviewer hand-edited the proposal
  push_status TEXT,                             -- null | pushed_suggestion | pushed_commit | push_failed
  push_error TEXT,                              -- error message if push failed
  external_id TEXT,                             -- GitHub suggestion/commit ID after successful push
  created_at TEXT NOT NULL
);
```

---

## Technical Requirements

### Effect Service: AgentService

```typescript
class AgentService extends Context.Tag("AgentService")<
  AgentService,
  {
    proposeChanges: (
      sessionId: string,
    ) => Stream<AgentProgressEvent, AgentError>;
    getAgentRun: (
      runId: string,
    ) => Effect<AgentRun & { proposals: ProposedChange[] }, AgentError>;
    listAgentRuns: (sessionId: string) => Effect<AgentRun[], AgentError>;
    updateProposalStatus: (
      changeId: string,
      status: ProposalStatus,
      editedContent?: string,
    ) => Effect<void, AgentError>;
    pushAccepted: (
      runId: string,
      method: PushMethod,
    ) => Effect<PushResult, PushError>;
  }
>() {}

type PushMethod = "github_suggestions" | "fixup_commit";

type AgentProgressEvent =
  | { type: "collecting"; data: { threadCount: number; messageCount: number } }
  | { type: "analyzing"; data: { message: string } }
  | { type: "generating"; data: { current: number; total: number } }
  | { type: "proposal"; data: ProposedChange }
  | { type: "summary"; data: { summary: string } }
  | {
      type: "done";
      data: {
        totalChanges: number;
        tokenUsage: { input: number; output: number };
      };
    }
  | { type: "error"; data: { message: string } };

interface PushResult {
  method: PushMethod;
  pushed: number;
  failed: number;
  errors: string[];
}
```

### Agent Prompt Design

The agent receives:

1. **All open/pending threads** with their full message history
2. **Full file content** for each file referenced by threads (from `fileContentCache`)
3. **The PR's unified diff** for broader context
4. **Walkthrough summary** (if available) — for high-level understanding
5. **Hunk decisions** — which hunks the reviewer accepted/rejected

The prompt instructs Claude to:

```
You are a code review agent. A reviewer has left comments on a pull request. Your job is to propose concrete code changes that address the reviewer's feedback.

For each change you propose:
1. Identify which thread(s) it addresses
2. Explain your rationale — why this change satisfies the reviewer's concern
3. Show the exact before/after code
4. Be conservative — only change what the comments ask for
5. If a comment is a question (not a change request), acknowledge it in the summary but don't modify code
6. Respect the codebase's style and patterns

Also consider the reviewer's hunk decisions:
- Accepted hunks: the reviewer is satisfied with these changes
- Rejected hunks: the reviewer wants these reverted or modified — prioritize addressing these

Output as structured JSON, one ProposedChange at a time. Include a final summary.
```

### SSE Streaming Endpoint

```
GET /api/reviews/:id/agent/propose
```

Streams `AgentProgressEvent` objects as SSE events. The agent works through phases:

1. **Collecting** — gathers threads, messages, file contents
2. **Analyzing** — Claude processes the review context
3. **Generating** — proposals stream out one by one
4. **Done** — final summary and token usage

### Elysia Routes

| Method  | Path                             | Description                                 |
| ------- | -------------------------------- | ------------------------------------------- |
| `GET`   | `/api/reviews/:id/agent/propose` | Stream change proposals (SSE)               |
| `GET`   | `/api/reviews/:id/agent/runs`    | List past agent runs for this session       |
| `GET`   | `/api/agent-runs/:id`            | Get a specific run with all its proposals   |
| `PATCH` | `/api/proposed-changes/:id`      | Update proposal status (accept/reject/edit) |
| `POST`  | `/api/agent-runs/:id/push`       | Push accepted changes to GitHub             |

### Push to GitHub

**Option A: GitHub Suggestions**

- For each accepted proposal, post a GitHub review comment with a suggestion block:

  ````markdown
  This addresses the concern about [thread summary].

  ```suggestion
  proposed code here
  ```
  ````

- Suggestion blocks render as one-click-apply on GitHub
- Requires the thread's `external_thread_id` for correct placement

**Option B: Fixup Commit**

- Collect all accepted proposals, apply them to the PR branch
- Create a single commit: `fixup: apply review suggestions from Revv`
- Uses GitHub Contents API (for single files) or Git Data API (for multi-file commits)
- Update `proposed_changes.push_status` and `external_id` (commit SHA)

### Frontend Components

| Component              | Description                                                           |
| ---------------------- | --------------------------------------------------------------------- |
| `AgentTrigger.svelte`  | Floating button at bottom-right: "Propose Changes (N threads)"        |
| `AgentPanel.svelte`    | Full-height slide-out panel for agent output                          |
| `AgentProgress.svelte` | Phase checklist: collecting → analyzing → generating → done           |
| `ProposalCard.svelte`  | Single proposal: related threads, rationale, diff, accept/reject/edit |
| `PushControls.svelte`  | After review: choose push method, execute, show results               |

### Agent Store State

Add to `review.svelte.ts` or create `agent.svelte.ts`:

```typescript
let agentRunId = $state<string | null>(null);
let agentStatus = $state<AgentRun["status"]>("pending");
let proposals = $state<ProposedChange[]>([]);
let agentSummary = $state<string | null>(null);
let isAgentStreaming = $state(false);

export function getProposals(): ProposedChange[] {
  return proposals;
}
export function getAgentStatus(): string {
  return agentStatus;
}
// ... etc
```

---

## UI Specification

### Agent Trigger

Floating button, bottom-right of review page. Only visible when there are open threads.

```
                                    ┌──────────────────────┐
                                    │ 🤖 Propose Changes   │
                                    │    3 open threads     │
                                    └──────────────────────┘
```

Also via keyboard shortcut: `Cmd+Shift+P`

### Agent Progress

Slide-out panel showing real-time progress:

```
+── Agent ──────────────────────────────────────────────+
|                                                        |
|  ✅ Collecting threads (3 threads, 7 messages)         |
|  ✅ Analyzing reviewer intent                          |
|  ⏳ Generating proposals... (2 of 3)                   |
|  ○  Finalizing summary                                 |
|                                                        |
+────────────────────────────────────────────────────────+
```

### Proposal Document

After generation completes, the panel shows a scrollable document:

```
+── Proposed Changes ───────────────────────────────────+
|                                                        |
|  Summary: 3 changes proposed addressing 3 threads.     |
|  The main fix adds a per-session refresh lock to       |
|  prevent concurrent token refreshes.                   |
|                                                        |
|  ─────────────────────────────────────────────         |
|                                                        |
|  1. Add refresh lock to token validator                |
|                                                        |
|  Addresses:                                            |
|  · Thread on validator.ts:45 — "race condition"        |
|                                                        |
|  This adds a Map-based lock that deduplicates          |
|  concurrent refresh calls for the same session.        |
|                                                        |
|  ┌─ src/auth/validator.ts ─────────────────────┐       |
|  │ - export async function validateToken(...)   │       |
|  │ + const refreshLock = new Map();             │       |
|  │ + export async function validateToken(...) { │       |
|  │ +   if (refreshLock.has(sessionId)) {        │       |
|  │ +     return refreshLock.get(sessionId);     │       |
|  │ +   }                                        │       |
|  │ +   const p = doRefresh(token);              │       |
|  │ +   refreshLock.set(sessionId, p);           │       |
|  │ +   return p.finally(() =>                   │       |
|  │ +     refreshLock.delete(sessionId));         │       |
|  │ + }                                          │       |
|  └──────────────────────────────────────────────┘       |
|                                                        |
|           [✅ Accept]  [✏️ Edit]  [❌ Reject]            |
|                                                        |
|  ─────────────────────────────────────────────         |
|                                                        |
|  2. Add error handling for expired sessions ...         |
|     ...                                                |
|                                                        |
|  ─────────────────────────────────────────────         |
|                                                        |
|  Push accepted changes:                                |
|  [As GitHub Suggestions]  [As Fixup Commit]            |
|                                                        |
+────────────────────────────────────────────────────────+
```

### Edit Flow

Clicking "Edit" on a proposal:

1. The proposed code becomes editable (textarea or CodeMirror)
2. The diff updates in real-time as the user types
3. "Save Edit" confirms → status becomes `accepted` with `edited_content`
4. "Cancel" reverts

### Push Status

After pushing, each proposal card shows:

- ✅ `Pushed as GitHub suggestion` — with link to the comment
- ✅ `Pushed in commit abc123` — with link to the commit
- ❌ `Push failed: [reason]` — with retry button

---

## Acceptance Criteria

- [ ] "Propose Changes" button appears when there are open threads
- [ ] Clicking it starts the agent — progress streams in real-time
- [ ] Agent output is a readable document with rationale + syntax-highlighted diffs
- [ ] Each proposal links to the thread(s) it addresses
- [ ] Accept/reject/edit controls work per proposal
- [ ] "Edit" opens editable code area, diff updates live
- [ ] "Push as GitHub Suggestions" posts suggestion blocks to the PR
- [ ] "Push as Fixup Commit" creates a commit on the PR branch
- [ ] After push, each proposal shows its push status (success/failure + link)
- [ ] Past agent runs are accessible (history view)
- [ ] Agent handles edge cases: question-only threads (no code change), threads on deleted files
- [ ] Error states: AI failure → message + retry button
- [ ] Rejected hunks are prioritized in the agent's analysis
- [ ] `Cmd+Shift+P` shortcut triggers the agent
- [ ] `bun run typecheck` passes
