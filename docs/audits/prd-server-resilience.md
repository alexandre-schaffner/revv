# Audit PRD: Server Architecture & Resilience

## Introduction

The server audit uncovered critical error-handling gaps, memory leaks, missing rate limiting, and architectural anti-patterns in `apps/server/src/`. These issues can crash the process, exhaust memory, leave the database inconsistent, or allow DoS attacks. This PRD groups them into implementable stories.

## Goals

- Eliminate unhandled promise rejections that can crash the server.
- Prevent memory leaks in long-running job orchestration.
- Add rate limiting to expensive sync endpoints.
- Ensure multi-step mutations are atomic.
- Harden graceful shutdown to drain in-flight requests.

## User Stories

### US-001: Add `.catch()` to walkthrough SSE `emitQueue`

**Description:** As an operator, I want the walkthrough SSE stream to survive rendering errors without crashing the server.

**Acceptance Criteria:**

- [ ] `apps/server/src/routes/reviews/handlers/walkthrough-stream.ts:264-291` appends `.catch(err => logError("walkthrough-sse", "emitQueue error:", err))` to the `emitQueue` chain.
- [ ] A failure in `prerenderBlock` logs the error and continues processing subsequent events.
- [ ] The server process does not terminate on `prerenderBlock` exceptions.
- [ ] `make typecheck` passes.

### US-002: Fix walkthrough auto-continuation exhaustion

**Description:** As a user, I want walkthroughs that complete phase D to transition to `complete` status, so that I can regenerate or review them.

**Acceptance Criteria:**

- [ ] `apps/server/src/services/WalkthroughJobs.ts:834-910` calls `setStatus(job.walkthroughId, "complete")` when `lastCompletedPhase === "D"` and auto-continuation budget is exhausted.
- [ ] `done` is still emitted to subscribers before the status change.
- [ ] The walkthrough row is no longer stuck in `generating`.
- [ ] `make typecheck` passes.

### US-003: Cap `limit` query parameter on archived PRs

**Description:** As an operator, I want the archived PR endpoint to reject unreasonably large limits, so that a single request cannot DoS the database.

**Acceptance Criteria:**

- [ ] `apps/server/src/routes/prs.ts:135-138` uses `const MAX_ARCHIVED_LIMIT = 100`.
- [ ] `params.limit = Math.min(Math.floor(n), MAX_ARCHIVED_LIMIT)`.
- [ ] Requests with `limit > 100` are silently clamped (or return 400).
- [ ] `make typecheck` passes.

### US-004: Add rate limiting to sync endpoints

**Description:** As an operator, I want sync triggers throttled per user, so that a buggy client cannot exhaust GitHub rate limits or CPU.

**Acceptance Criteria:**

- [ ] `apps/server/src/routes/prs.ts:384-392` (`POST /api/prs/sync`) enforces a minimum 10-second interval per `accountId`.
- [ ] `apps/server/src/routes/ws.ts:93-94` (`prs:request-sync`) enforces the same 10-second interval.
- [ ] Violations return `429 Too Many Requests` with `Retry-After` header.
- [ ] Rate-limit state is stored in-memory (acceptable for single-instance server).
- [ ] `make typecheck` passes.

### US-005: Clean up `startJobMutexes` after job completion

**Description:** As an operator, I want per-PR job mutexes removed after use, so that long-running server processes don't leak memory.

**Acceptance Criteria:**

- [ ] `apps/server/src/services/WalkthroughJobs.ts:337-354` deletes the mutex from `startJobMutexes` after `startJob` completes (success or failure).
- [ ] A new `Semaphore` is still created for each new `prId` on demand.
- [ ] Memory profile (observed via logs) shows map size does not grow indefinitely.
- [ ] `make typecheck` passes.

### US-006: Await `app.stop()` during graceful shutdown

**Description:** As an operator, I want the server to drain in-flight requests before tearing down services, so that no request is interrupted mid-flight.

**Acceptance Criteria:**

- [ ] `apps/server/src/index.ts:115` uses `await app.stop();`.
- [ ] `AppRuntime.dispose()` is called only after `app.stop()` resolves.
- [ ] A test with an in-flight HTTP request confirms the response completes before shutdown.
- [ ] `make typecheck` passes.

### US-007: Log swallowed errors in `emitEvent` callback

**Description:** As a developer, I want to see why walkthrough stream events fail to fan out, so that I can debug subscriber issues.

**Acceptance Criteria:**

- [ ] `apps/server/src/services/WalkthroughJobs.ts:602-608` logs the caught error with `logError`.
- [ ] Error message includes `job.walkthroughId` for correlation.
- [ ] `make typecheck` passes.

### US-008: Add authorization checks to review session routes

**Description:** As a user, I want my review session data accessible only to me, so that other users cannot read or submit comments on my PRs.

**Acceptance Criteria:**

- [ ] `apps/server/src/routes/reviews.ts:31-37` (`/active/:prId`) validates that the PR belongs to `ctx.session.user.id` before returning session data.
- [ ] `apps/server/src/routes/reviews.ts:282-299` (`/github-submit`) validates that every `threadId` exists within the review session.
- [ ] Unauthorized access returns `403 Forbidden`.
- [ ] `make typecheck` passes.

### US-009: Add `maxLength` to thread creation strings

**Description:** As an operator, I want oversized thread bodies rejected at the API layer, so that the database and memory are protected.

**Acceptance Criteria:**

- [ ] `apps/server/src/routes/reviews.ts:147-166` adds `t.String({ maxLength: 100_000 })` to `body`.
- [ ] `codeSuggestion`, `filePath`, and other string fields also have reasonable `maxLength` limits.
- [ ] Requests exceeding limits return `413 Payload Too Large`.
- [ ] `make typecheck` passes.

### US-010: Add global unhandled rejection / uncaught exception handlers

**Description:** As an operator, I want the server to log and attempt graceful shutdown on unexpected errors, so that the process doesn't terminate silently.

**Acceptance Criteria:**

- [ ] `apps/server/src/index.ts` registers `process.on("unhandledRejection", ...)` that logs and calls graceful shutdown.
- [ ] `process.on("uncaughtException", ...)` does the same.
- [ ] Both handlers include the error stack trace in logs.
- [ ] `make typecheck` passes.

### US-011: Wrap multi-step mutations in database transactions

**Description:** As a user, I want operations like `supersedeWalkthrough` or `mergePullRequest` to be all-or-nothing, so that a crash mid-operation doesn't corrupt the database.

**Acceptance Criteria:**

- [ ] `apps/server/src/services/WalkthroughJobs.ts` `supersedeWalkthrough` uses a Drizzle transaction.
- [ ] `apps/server/src/services/PullRequest.ts` `mergePullRequest` uses a Drizzle transaction.
- [ ] All writes inside the transaction are rolled back on failure.
- [ ] `make typecheck` passes.

## Functional Requirements

- FR-1: SSE `emitQueue` must never propagate unhandled rejections.
- FR-2: Walkthrough status must transition to `complete` when phase D is reached.
- FR-3: `limit` query param must be capped at 100.
- FR-4: Sync endpoints must enforce a 10-second per-account rate limit.
- FR-5: Per-PR job mutexes must be cleaned up after use.
- FR-6: `app.stop()` must be awaited during shutdown.
- FR-7: Swallowed callback errors must be logged.
- FR-8: Review routes must validate user ownership of PRs and threads.
- FR-9: String inputs must have `maxLength` validation.
- FR-10: Process must have global error handlers.
- FR-11: Multi-step DB mutations must use transactions.

## Non-Goals

- Replacing the Effect runtime with a different framework.
- Adding a distributed rate limiter (single-instance is acceptable).
- Rewriting the walkthrough pipeline logic.
- Adding a full authorization framework (RBAC/ABAC).

## Technical Considerations

- Use existing `Effect.tryPromise` + tagged error patterns for DB calls.
- Rate limiter can be a simple `Map<accountId, lastSyncAt>` in `Sync.ts`.
- Transactions use Drizzle's `db.transaction(async (tx) => { ... })`.
- Follow existing `logError` / `logDebug` conventions.

## Success Metrics

- Server process survives `prerenderBlock` exceptions without crashing.
- Walkthrough rows transition to `complete` after phase D.
- `?limit=999999` is clamped to 100.
- Rapid sync triggers return 429.
- `startJobMutexes` map size is observed to be stable over time.
- In-flight HTTP requests complete before shutdown.
- `make typecheck && make lint` passes.

## Open Questions

- Should the rate limiter be per-IP, per-account, or both?
- Should transactions also cover the review session lifecycle (create, update, delete)?
- Should global error handlers attempt an automatic restart, or just graceful shutdown?
