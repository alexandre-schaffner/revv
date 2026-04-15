# PRD-01: Comment Persistence & Review Sessions

## Priority: P0 (Foundation for all review features)
## Dependencies: None — builds on existing in-memory comment UI
## Estimated: 3-4 days

---

## Objective

Wire the existing in-memory comment system to SQLite so that review sessions, comment threads, thread messages, and hunk accept/reject decisions survive page navigation and app restarts. This is the foundation that every subsequent PRD depends on.

---

## Current State

The frontend already has:
- `AnnotationCommentInput.svelte` — inline comment input at a diff line
- `AnnotationThread.svelte` — expandable thread display in diff gutter
- `review.svelte.ts` store — manages `threads: CommentThread[]`, `threadMessages: Record<string, ThreadMessage[]>`, `acceptedHunks`, `rejectedHunks` as in-memory `$state`
- `review.ts` types — `CommentThread`, `ThreadMessage`, `ThreadStatus`, `AuthorRole`, `MessageType` fully defined
- `applyCommentSuggestion()` — applies a code suggestion and auto-resolves the thread

**What's missing:** All of this is in-memory. Refreshing the page loses everything. There are no database tables for reviews, no API routes for CRUD, and the store actions don't call the server.

---

## Data Model

### New Tables (Drizzle SQLite)

```sql
-- Review sessions: one per PR review sitting
CREATE TABLE review_sessions (
  id TEXT PRIMARY KEY,                          -- UUID
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,                     -- ISO timestamp
  completed_at TEXT,                            -- null while active
  status TEXT NOT NULL DEFAULT 'active'         -- active | completed | abandoned
);

-- Comment threads: anchored to a file + line range in a diff
CREATE TABLE comment_threads (
  id TEXT PRIMARY KEY,                          -- UUID
  review_session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  diff_side TEXT NOT NULL DEFAULT 'new',        -- 'old' | 'new'
  status TEXT NOT NULL DEFAULT 'open',          -- open | pending_coder | pending_reviewer | resolved | wont_fix
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- Individual messages within a thread
CREATE TABLE thread_messages (
  id TEXT PRIMARY KEY,                          -- UUID
  thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  author_role TEXT NOT NULL DEFAULT 'reviewer', -- reviewer | coder | ai_agent
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,                           -- markdown content
  message_type TEXT NOT NULL DEFAULT 'comment', -- comment | reply | suggestion | resolution
  code_suggestion TEXT,                         -- proposed code replacement (nullable)
  created_at TEXT NOT NULL,
  edited_at TEXT,
  external_id TEXT                              -- GitHub comment ID (null until PRD-04 sync)
);

-- Hunk decisions: persists accept/reject per hunk per review session
CREATE TABLE hunk_decisions (
  id TEXT PRIMARY KEY,                          -- UUID
  review_session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  hunk_index INTEGER NOT NULL,
  decision TEXT NOT NULL,                       -- 'accepted' | 'rejected'
  decided_at TEXT NOT NULL,
  UNIQUE(review_session_id, file_path, hunk_index)
);
```

### Indexes

```sql
CREATE INDEX idx_threads_session ON comment_threads(review_session_id);
CREATE INDEX idx_threads_file ON comment_threads(file_path);
CREATE INDEX idx_messages_thread ON thread_messages(thread_id);
CREATE INDEX idx_hunks_session ON hunk_decisions(review_session_id);
```

---

## Technical Requirements

### Effect Service: ReviewService

```typescript
class ReviewService extends Context.Tag("ReviewService")<ReviewService, {
  // Sessions
  createSession: (prId: string) => Effect<ReviewSession, ReviewError>;
  getSession: (id: string) => Effect<ReviewSession, ReviewError>;
  getActiveSession: (prId: string) => Effect<ReviewSession | null, ReviewError>;
  completeSession: (id: string) => Effect<void, ReviewError>;

  // Threads
  createThread: (params: CreateThreadParams) => Effect<CommentThread, ReviewError>;
  getThreadsForSession: (sessionId: string) => Effect<CommentThread[], ReviewError>;
  getThreadsForFile: (sessionId: string, filePath: string) => Effect<CommentThread[], ReviewError>;
  updateThreadStatus: (threadId: string, status: ThreadStatus) => Effect<void, ReviewError>;

  // Messages
  addMessage: (threadId: string, params: CreateMessageParams) => Effect<ThreadMessage, ReviewError>;
  getMessages: (threadId: string) => Effect<ThreadMessage[], ReviewError>;

  // Hunk decisions
  setHunkDecision: (sessionId: string, filePath: string, hunkIndex: number, decision: 'accepted' | 'rejected') => Effect<void, ReviewError>;
  clearHunkDecision: (sessionId: string, filePath: string, hunkIndex: number) => Effect<void, ReviewError>;
  getHunkDecisions: (sessionId: string) => Effect<HunkDecision[], ReviewError>;
}>() {}
```

### Elysia Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/reviews` | Create a new review session for a PR |
| `GET` | `/api/reviews/active/:prId` | Get or create the active review session for a PR |
| `PATCH` | `/api/reviews/:id` | Update session status (complete/abandon) |
| `GET` | `/api/reviews/:id/threads` | List all threads for a session |
| `POST` | `/api/reviews/:id/threads` | Create a thread (with initial message) |
| `PATCH` | `/api/threads/:id` | Update thread status (resolve, wont_fix, reopen) |
| `GET` | `/api/threads/:id/messages` | List messages in a thread |
| `POST` | `/api/threads/:id/messages` | Add a message to a thread |
| `GET` | `/api/reviews/:id/hunks` | Get all hunk decisions for a session |
| `PUT` | `/api/reviews/:id/hunks` | Set a hunk decision (upsert) |
| `DELETE` | `/api/reviews/:id/hunks/:filePath/:hunkIndex` | Clear a hunk decision |

### Frontend Store Changes

Update `review.svelte.ts` to call API endpoints instead of only mutating local state. The pattern:

```typescript
// Before (current — in-memory only)
export function addThread(thread: CommentThread): void {
  threads = [...threads, thread];
}

// After (persisted)
export async function addThread(sessionId: string, params: CreateThreadParams): Promise<void> {
  const { data, error } = await api.reviews({ id: sessionId }).threads.post(params);
  if (error) { setError(error.message); return; }
  threads = [...threads, data];
}
```

Key changes:
1. `addThread` / `addThreadMessage` / `resolveThread` → call API, then update local state on success
2. `acceptHunk` / `rejectHunk` / `undoHunkAction` → call API, then update local Maps
3. Add `loadSession(prId)` — fetches or creates active session, loads threads + messages + hunk decisions from server
4. Add `sessionId` tracking in the store (set on session load)
5. `clearReviewFiles()` extended to also clear persisted session state

### Session Lifecycle

When user navigates to `/review/[prId]`:
1. Call `GET /api/reviews/active/:prId` — returns existing active session or creates one
2. Load all threads for the session → populate `threads` state
3. Load all messages for each thread → populate `threadMessages` state
4. Load hunk decisions → populate `acceptedHunks` / `rejectedHunks` Maps
5. Store is now hydrated — UI renders with persisted data

When user completes a review or navigates away:
- Session stays active (can resume later)
- `completeSession` available as explicit action

---

## WebSocket Integration

Add new message types for real-time thread updates:

```typescript
// In packages/shared/src/ws.ts — add to WsServerMessage:
| { type: 'thread:created'; data: { sessionId: string; thread: CommentThread; message: ThreadMessage } }
| { type: 'thread:updated'; data: { threadId: string; status: ThreadStatus } }
| { type: 'thread:message'; data: { threadId: string; message: ThreadMessage } }
```

The server broadcasts these when threads are modified, so multiple windows (or future multi-user) stay in sync.

---

## Acceptance Criteria

- [ ] Create a review session by opening a PR — session persists in SQLite
- [ ] Add a comment on a diff line → thread + message saved to database
- [ ] Refresh the page → comment thread reappears exactly where it was
- [ ] Resolve a thread → status updates in DB, gutter marker turns gray
- [ ] Reopen a resolved thread → status resets
- [ ] Accept/reject a hunk → decision persists across page refresh
- [ ] Undo a hunk decision → row deleted from database
- [ ] Multiple threads on the same file work correctly
- [ ] Navigate between PRs → each PR loads its own session and threads
- [ ] Close and reopen the app → all review data intact
- [ ] `bun run typecheck` passes
- [ ] No regressions in existing comment/thread UI behavior
