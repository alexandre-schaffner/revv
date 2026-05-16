# PRD-05: Chat-Driven Changes

## Status: **SHIPPED (core) + PARTIAL polish**
## Priority: P1 (AI automation)
## Dependencies: PRD-01 (threads), PRD-02 (chat agent), PRD-04 (sync sets up the GitHub side)
## Original PRD-05 scope: A separate "Post-Review Agent" run with `agent_runs` + `proposed_changes` tables, GitHub suggestion comments. **Replaced** by always-on chat-driven editing with a real-git proposed-commits strip.
## Last updated: 2026-05-16

---

## Objective

Let a reviewer drive code changes from the chat surface against the PR — the agent reads threads, asks clarifying questions, edits files in a per-PR worktree, and accumulates real git commits the reviewer can review, cherry-pick, comment on, discard, or push back to the PR branch. Conflict resolution during push is handed back to the agent so the human stays out of the merge tool.

This PRD replaces the original "Post-Review Agent" spec. The original direction (batch agent run + GitHub-suggestion comments + `proposed_changes` table) was abandoned in favour of treating the chat conversation as the agent run, and treating the worktree's commit log as the proposal queue.

---

## What we built

### Per-PR worktree + working branch

Every chat session gets a dedicated git worktree at the PR's head SHA, on a local branch named `pr-{prNumber}` (managed by `ChatSessionService`, `RepoCloneService`). Agent edits are normal `git commit` operations on that branch. Worktree lifecycle is registered as a scope finalizer so cleanup happens on every exit path — consistent with the per-job resource scoping invariant in CLAUDE.md.

### Proposed-commits strip (`apps/server/src/routes/chat-route-proposed-changes.ts`)

The "proposed changes" the reviewer sees are just the commits between the PR's remote head and the local `pr-{N}` branch tip, queried on demand via `git log` rather than stored in a separate table. The route exposes:

- `GET /api/chat/:prId/proposed-changes` — list of proposed commits
- `GET /api/chat/:prId/proposed-changes/:sha/diff` — diff for one
- `POST /api/chat/:prId/proposed-changes/:sha/discard` — drop a commit
- `POST /api/chat/:prId/proposed-changes/:sha/cherry-pick` — push only this commit
- `POST /api/chat/:prId/push` — push the entire `pr-{N}` ahead-of-remote stack
- comment routes that anchor reviewer feedback to a proposed commit's file/line

### Merge + push (`apps/server/src/services/ChatChangesPush.ts`)

`attemptMergeAndPush` is the "Push" button's full path. Documented at the top of the file; abbreviated:

1. Acquire per-PR push lock; refuse on overlap
2. Verify worktree clean, ≥1 agent commit
3. Capture remote tip via `git ls-remote` (used as the lease guard)
4. Fetch the remote source branch
5. Switch worktree from `pr-{N}` to a local copy of the source branch
6. `git merge pr-{N} --no-edit` — fast-forward if possible, real merge commit otherwise
7. On conflict: `git merge --abort`, restore worktree to `pr-{N}`, return conflicting file list
8. On clean merge: `git push --force-with-lease={ref}:{capturedSha}` using the user's GitHub token (never persisted in `.git/config`)
9. Move `pr-{N}` to the new tip; check it out (worktree returns to conceptual starting state)
10. Re-fetch PR meta from GitHub so `pull_requests.headSha` reflects the new tip
11. Update `chat_sessions.prHeadSha = newTip` so the session lookup keeps finding the conversation
12. Broadcast `prs:updated`

GitHub host is resolved at call time from `SettingsService` so the same code path works against `github.com` and GHE.

### AI-driven conflict resolution

When step 7 hits a conflict, `resolveConflictsAndPush` re-runs the merge into the conflicted state and hands the worktree to the chat agent through `AiService.resolveMergeConflict` — a one-shot, non-persisted agent run with a dedicated system prompt. The stream frames pass through to the SSE client so the reviewer sees the agent's progress inline. After the agent stream ends:

- If `MERGE_HEAD` is gone and the index is clean → finish the push as in steps 8–12
- Otherwise → `git merge --abort` so the worktree returns to a clean `pr-{N}` and the reviewer decides what to do

### Cherry-pick path

The proposed-commits strip lets the reviewer ship one commit at a time. After cherry-picking a single commit onto the source branch, the service rebases the remaining agent commits on `pr-{N}` so the unpushed proposals still apply against the new tip. If the rebase fails, the agent branch is restored to its pre-cherry-pick state — the push still succeeded but a follow-up turn can re-derive the dropped work.

### Frontend (`apps/web/src/lib/`)

- `components/review/ProposedDiffModal.svelte` — modal renderer for a single proposed commit; supports comments via `ProposedCommentChip.svelte` and `AnnotationCommentInput.svelte`
- `components/layout/CommitsDropdown.svelte` — proposed-commits strip surface in the chat panel header
- `stores/chat.svelte.ts` — proposed-commit state (loaded from `proposed-changes` endpoint, hydrated alongside chat history)
- The chat input flow handles the "Push" button via the same SSE that streams chat replies, so conflict-resolution progress shows inline

### Schema

There is **no** `agent_runs` or `proposed_changes` table. Agent work lives in the chat schema (PRD-02): `chat_sessions`, `chat_messages`, `chat_tasks`, `chat_plans`, `chat_activities`, `chat_questions`, `chat_subagent_invocations`. The proposal queue is the git log of `pr-{N}` ahead of the remote tip — git is the source of truth, not a mirror table.

### Reviewer feedback on proposed commits

Comments left against a proposed commit's diff use the same `comment_threads` + `thread_messages` infrastructure as inline PR comments (`ProposedCommentChip.svelte` + `addProposedComment` / `removeProposedComment` in the chat store). These don't go to GitHub — they're feedback to the agent, fed back into the next chat turn.

---

## Architecture notes

- **No GitHub suggestion comments.** The original spec proposed `POST review comment with `\`\`\`suggestion\`\`\`` blocks; reality uses `git merge --force-with-lease` for full commits and per-commit cherry-pick for granular pushes. Trade-off: we lose GitHub's one-click-apply UI on suggestions, but we gain full commits with messages and the option of multi-file changes.
- **Always-on, not a separate trigger.** No floating "Propose Changes" button or `Cmd+Shift+P` agent shortcut; the chat panel is always available and the agent is always the same agent that handles every other interaction. Hence this PRD becomes a thin layer over PRD-02.
- **`--force-with-lease`, not `--force`.** The captured remote tip from step 3 is the lease key — if someone else pushed between our fetch and our push, we fail cleanly instead of stomping.

---

## Remaining gaps

- [ ] **Per-proposal status badges.** The strip lists commits but doesn't surface "pushed cleanly" / "cherry-picked" / "had conflicts" history per commit beyond the most recent push
- [ ] **Rationale display.** Commit messages exist; a richer "this commit addresses thread X, Y" rationale block (linking back into the comment system) is not yet on the strip
- [ ] **Push status feedback.** Inline progress is good; persistent "last push: 12 min ago to {sha}" indicator is missing
- [ ] **Agent run history view.** No dedicated UI for past pushes / past proposed sets beyond scrolling the chat
- [ ] **Multi-PR queue.** Today each chat session is per-PR; the queue is not visible across PRs in a single dashboard
- [ ] **Conflict-resolution timeouts / cancel.** Long-running conflict streams can be cancelled by closing the panel, but there's no explicit "stop trying" UI
- [ ] **Lease failure UX.** When `--force-with-lease` rejects due to remote-changed, the surface should suggest "refresh and retry" instead of a generic error

---

## Cross-references

- **PRD-02 (Chat Agent)** — owns the conversation, MCP, opencode supervisor; this PRD is the action layer that sits on top
- **PRD-04 (GitHub Sync)** — separate "comments to GitHub" path; this PRD does **not** push as suggestion comments
- **CLAUDE.md, "Agent Subsystem Invariants"** — per-job resource scoping (worktree as scope finalizer) and bounded retries apply here too
- **07-emergent-features.md** — proposed-changes strip, AI conflict resolution

---

## Acceptance criteria (delta only — shipped items not re-listed)

- [ ] Push with no conflicts succeeds in one chat turn; the proposed-commits strip empties; `pull_requests.headSha` and `chat_sessions.prHeadSha` are updated
- [ ] Push with conflicts hands off to the agent inline; reviewer sees the agent's progress; on successful resolution the push completes; on giveup, the worktree is restored to `pr-{N}` cleanly
- [ ] Cherry-pick of one commit lands on the remote; remaining `pr-{N}` commits still apply (rebase succeeds) or are restored to pre-cherry-pick state (rebase fails)
- [ ] `--force-with-lease` rejects on stale remote tip without stomping
- [ ] Switching the active chat session away mid-push neither corrupts state nor leaves the lock held
- [ ] `make typecheck` and `make lint` pass
