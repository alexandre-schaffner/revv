# PRD-04: GitHub Sync & Conversations

## Priority: P1 (Collaboration)
## Dependencies: PRD-01 (persisted threads, review sessions)
## Estimated: 5-6 days

---

## Objective

Make comments bidirectional. Threads created in Rev push to GitHub as review comments. Comments made on GitHub pull into Rev. Thread status tracks whose turn it is (reviewer vs coder). This turns Rev from a solo review tool into a conversation platform that stays in sync with the GitHub PR.

---

## Current State

From PRD-01 we'll have:
- `comment_threads` and `thread_messages` tables in SQLite
- `ReviewService` for CRUD operations on threads and messages
- WebSocket broadcast when threads change

The `CommentThread` type already defines `ThreadStatus`: `'open' | 'pending_coder' | 'pending_reviewer' | 'resolved' | 'wont_fix'` — the status machine values are in the types but no transition logic exists.

**What's missing:**
- No GitHub comment push (Rev → GitHub)
- No GitHub comment pull (GitHub → Rev)
- No thread status transitions based on who replies
- No user identity awareness (who is reviewer vs coder)
- No sidebar badges showing thread counts
- No notifications

---

## Thread Status Machine

```
                ┌──────────────┐
   create ────> │    open      │
                └──────┬───────┘
                       │
          reviewer posts first comment
                       │
                ┌──────▼───────┐
                │ pending_coder│ <───── reviewer replies
                └──────┬───────┘
                       │
             coder replies
                       │
                ┌──────▼────────┐
                │pending_reviewer│ <──── coder replies again
                └──────┬────────┘
                       │
          reviewer replies (→ pending_coder)
          OR resolves / won't fix
                       │
         ┌─────────────┼─────────────┐
         │                           │
  ┌──────▼───────┐           ┌───────▼──────┐
  │   resolved   │           │   wont_fix   │
  └──────────────┘           └──────────────┘
         │                           │
         └──── can be reopened ──────┘
                       │
                ┌──────▼───────┐
                │    open      │
                └──────────────┘
```

**Transition rules:**
- Thread created by reviewer → `open` (auto-transitions to `pending_coder` when first message is sent)
- Reviewer posts message → `pending_coder`
- Coder posts message → `pending_reviewer`
- AI posts message → status unchanged (AI is a helper, not a participant)
- Either party resolves → `resolved`
- Either party marks won't fix → `wont_fix`
- Either party reopens → `open`

---

## Schema Changes

### New Columns on `comment_threads`

```sql
ALTER TABLE comment_threads ADD COLUMN external_thread_id TEXT;  -- GitHub review thread ID
ALTER TABLE comment_threads ADD COLUMN last_synced_at TEXT;       -- ISO timestamp of last sync
```

### User Identity

We already have the authenticated user from Better Auth. The server needs to:
1. Know the current user's GitHub login (from the `account` table)
2. Compare against `pullRequests.authorLogin` to determine if the user is the coder or reviewer
3. Expose this via API so the frontend can render status-aware UI

---

## Technical Requirements

### Effect Service: SyncService

```typescript
class SyncService extends Context.Tag("SyncService")<SyncService, {
  // Bidirectional sync for a PR's threads
  syncThreads: (prId: string) => Effect<SyncResult, SyncError>;

  // Push a single thread + messages to GitHub
  pushThread: (threadId: string) => Effect<void, SyncError>;

  // Push a reply to an existing GitHub thread
  pushReply: (messageId: string) => Effect<void, SyncError>;

  // Push resolve/unresolve to GitHub
  pushThreadStatus: (threadId: string) => Effect<void, SyncError>;

  // Pull all comments from GitHub for a PR
  pullComments: (prId: string) => Effect<PullResult, SyncError>;

  // Thread summary for sidebar badges
  getThreadSummary: (prId: string, userLogin: string) => Effect<ThreadSummary, SyncError>;
}>() {}

interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
}

interface PullResult {
  newThreads: number;
  newMessages: number;
  statusChanges: number;
}

interface ThreadSummary {
  total: number;
  open: number;
  pendingYou: number;
  pendingThem: number;
  resolved: number;
}
```

### ReviewService Enhancement

Add status transition logic:

```typescript
// In ReviewService
transitionStatus: (threadId: string, authorRole: AuthorRole) => Effect<ThreadStatus, ReviewError>;
```

The transition logic:
```typescript
function nextStatus(currentStatus: ThreadStatus, authorRole: AuthorRole): ThreadStatus {
  if (authorRole === 'ai_agent') return currentStatus;  // AI doesn't change status
  if (authorRole === 'reviewer') return 'pending_coder';
  if (authorRole === 'coder') return 'pending_reviewer';
  return currentStatus;
}
```

### GitHub API Integration

**Push: Rev → GitHub**

| Rev Action | GitHub API |
|---|---|
| New thread + first message | `POST /repos/{owner}/{repo}/pulls/{number}/reviews` (with comments array) — creates a review with line comments |
| Reply to thread | `POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/replies` |
| Resolve thread | GraphQL: `resolveReviewThread(input: { threadId })` |
| Unresolve/reopen | GraphQL: `unresolveReviewThread(input: { threadId })` |

**Pull: GitHub → Rev**

| GitHub State | Rev Action |
|---|---|
| New review comment (no matching `external_id`) | Create thread + message |
| Reply to known comment | Add message to matching thread |
| Thread resolved on GitHub | Update thread status to `resolved` |
| Comment edited | Update message body + `edited_at` |

**Matching logic:**
- `thread_messages.external_id` ↔ GitHub comment ID
- `comment_threads.external_thread_id` ↔ GitHub review thread ID (GraphQL `pullRequestReviewThread.id`)
- On pull, skip any comment whose `external_id` already exists in Rev

### Sync Polling

- Default interval: 30 seconds (configurable in settings)
- Integrate with existing `PollScheduler` — add thread sync to the polling cycle
- Or: separate lighter-weight poll for threads (since PR sync is heavier)
- Sync triggered on: interval, manual "Sync" action, window focus

### Elysia Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/prs/:id/sync-threads` | Trigger bidirectional thread sync for a PR |
| `GET` | `/api/prs/:id/thread-summary` | Get thread count summary (for sidebar badge) |
| `POST` | `/api/threads/:id/reopen` | Reopen a resolved/wont_fix thread |
| `GET` | `/api/user/identity` | Current user's GitHub login + role info |

### WebSocket Messages

Add sync-related broadcasts:

```typescript
// New server → client messages
| { type: 'threads:synced'; data: { prId: string; summary: ThreadSummary } }
| { type: 'threads:new-reply'; data: { prId: string; threadId: string; message: ThreadMessage } }
```

### Frontend Changes

**Sidebar badge (`PrItem.svelte`):**
- Fetch thread summary per PR (batch with PR list load, or lazy on sidebar render)
- Display: `🔵2 🟠1` — 2 open, 1 pending you
- Only show badges when counts > 0

**Gutter marker colors (update `AnnotationThread.svelte`):**

| Color | When |
|---|---|
| Blue (`#58a6ff`) | `open`, or waiting on the other person |
| Orange (`#d29922`) | **Your turn** — `pending_coder` if you're the coder, `pending_reviewer` if you're the reviewer |
| Gray (`#484f58`) | `resolved` or `wont_fix` |

**Thread UI enhancements:**
- Show status label in thread header: "Pending you" / "Waiting on coder" / "Resolved"
- Reply auto-transitions status (frontend calls API, which handles transition)
- "Reopen" button on resolved threads
- Sync indicator: small icon showing when thread was last synced

**Identity awareness:**
- Store current user's GitHub login in auth store
- Pass to thread-related components for role determination
- `isYourTurn(thread, userLogin, prAuthorLogin)` helper function

---

## UI Specification

### Sidebar Badge

```
| v  acme/frontend         3  |
|   ●  Fix auth redirect      |
|   ★  Refactor API layer  🔵2 🟠1  |  ← 2 open, 1 pending you
|   ●  Update dependencies     |
```

### Enhanced Thread Display

```
| [🟠]45|+   return refreshToken(decoded);            |
|       | ┌─ Thread · 🟠 Pending you ─────────────────┐|
|       | │                                           │|
|       | │ 👤 Alex (reviewer)               2m ago   │|
|       | │ Race condition in refresh logic.           │|
|       | │                                           │|
|       | │ 👤 You (coder)                 just now   │|
|       | │ Good catch. I'll add a mutex.              │|
|       | │                                           │|
|       | │ [Reply]  [Resolve ✓]  [Won't Fix]         │|
|       | └───────────────────────────────────────────┘|
```

### Sync Status

Small indicator in the bottom bar or top bar:
- `⟳ Synced 12s ago` — shows last sync time
- `⟳ Syncing...` — during active sync
- `⚠ Sync failed` — with retry button

---

## Acceptance Criteria

- [ ] Thread status transitions: reviewer creates → `open`, reviewer posts → `pending_coder`, coder replies → `pending_reviewer`
- [ ] Gutter markers show correct color based on status + current user's role
- [ ] Sidebar shows thread summary badge per PR (`🔵2 🟠1`)
- [ ] Current user's role is correctly identified (reviewer vs coder based on PR author)
- [ ] **Push to GitHub**: new thread → creates GitHub review comment at correct file/line
- [ ] **Push to GitHub**: reply → creates GitHub reply comment
- [ ] **Push to GitHub**: resolve → resolves thread on GitHub
- [ ] **Pull from GitHub**: new GitHub comment → creates Rev thread + message
- [ ] **Pull from GitHub**: GitHub reply → adds message to matching Rev thread
- [ ] **Pull from GitHub**: GitHub resolve → updates Rev thread status
- [ ] **Pull from GitHub**: GitHub edit → updates Rev message body
- [ ] No duplicate comments after sync (matching by `external_id`)
- [ ] Sync polling runs every 30s (configurable)
- [ ] Sync handles GitHub rate limits (backoff, status display)
- [ ] Reopen button works on resolved threads
- [ ] Thread status label visible in thread UI
- [ ] `bun run typecheck` passes
