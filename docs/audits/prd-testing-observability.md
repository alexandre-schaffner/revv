# Audit PRD: Testing & Observability

## Introduction

The codebase currently has **zero test files** (`*.test.ts`, `*.spec.ts`, etc.). The audit uncovered multiple bugs (duplicate PRs, reconnect loops, half-logout states, walkthrough status stuck in `generating`) that would have been caught by even basic integration or unit tests. This PRD establishes a minimal but effective testing and observability foundation.

## Goals

- Add unit tests for the most bug-prone store modules.
- Add integration tests for critical server routes.
- Add smoke tests for the walkthrough pipeline.
- Improve error logging and observability to reduce time-to-debug.

## User Stories

### US-001: Add unit tests for `prs.svelte.ts` deduplication

**Description:** As a developer, I want tests covering `mergePullRequests`, so that the duplicate PR bug cannot regress.

**Acceptance Criteria:**

- [ ] `apps/web/src/lib/stores/prs.svelte.test.ts` is created.
- [ ] Test: merging a PR list with itself produces no duplicates.
- [ ] Test: merging a new PR into an existing list appends it.
- [ ] Test: merging a PR with updated fields replaces the old one.
- [ ] Tests run with `bun test`.

### US-002: Add unit tests for `auth.svelte.ts` state transitions

**Description:** As a developer, I want tests covering sign-out, account removal, and user updates, so that half-logout and avatar-loss bugs cannot regress.

**Acceptance Criteria:**

- [ ] `apps/web/src/lib/stores/auth.svelte.test.ts` is created.
- [ ] Test: `removeAccount` clears token even when the network fetch throws.
- [ ] Test: `applyUserUpdate` preserves `image` when the update omits it.
- [ ] Test: `loadUser` calls `clearToken` on 401.
- [ ] Tests run with `bun test`.

### US-003: Add unit tests for `events.svelte.ts` reconnect logic

**Description:** As a developer, I want tests covering the SSE store's watchdog/reconnect behavior, so that the disconnect→reconnect loop bug cannot regress.

**Acceptance Criteria:**

- [ ] `apps/web/src/lib/stores/events.svelte.test.ts` is created.
- [ ] Test: calling `disconnect()` closes the `EventSource`, clears the watchdog, and does not reconnect.
- [ ] Test: the watchdog force-reconnects after >60s of silence (no heartbeat or message).
- [ ] Test: a reconnect uses the current token, not a stale one.
- [ ] Tests run with `bun test`.

### US-004: Add integration tests for PR route handlers

**Description:** As a developer, I want tests covering the PR list and sync endpoints, so that limit-capping and rate-limiting logic is verified.

**Acceptance Criteria:**

- [ ] `apps/server/src/routes/prs.test.ts` is created.
- [ ] Test: `GET /api/prs/archived?limit=200` returns at most 100 results.
- [ ] Test: `POST /api/prs/sync` returns 429 when called twice within 10 seconds.
- [ ] Test: `GET /api/prs` returns 401 without a valid token.
- [ ] Tests use an in-memory SQLite database and run with `bun test`.

### US-005: Add integration tests for review session routes

**Description:** As a developer, I want tests covering review session authorization, so that cross-user data leaks are prevented.

**Acceptance Criteria:**

- [ ] `apps/server/src/routes/reviews.test.ts` is created.
- [ ] Test: `GET /api/reviews/active/:prId` returns 403 for a PR belonging to another user.
- [ ] Test: `POST /api/reviews/github-submit` rejects thread IDs not in the session.
- [ ] Test: creating a thread with a body > 100k returns 413.
- [ ] Tests use an in-memory SQLite database and run with `bun test`.

### US-006: Add smoke test for walkthrough pipeline completion

**Description:** As a developer, I want a test simulating the 4-phase walkthrough pipeline, so that status transitions and phase preconditions are verified.

**Acceptance Criteria:**

- [ ] `apps/server/src/services/WalkthroughJobs.test.ts` is created.
- [ ] Test: pipeline reaching phase D transitions status to `complete`.
- [ ] Test: out-of-order MCP tool calls fail with precondition errors.
- [ ] Test: auto-continuation budget exhaustion does not leave status as `generating`.
- [ ] Tests mock the AI stream and DB layer; run with `bun test`.

### US-007: Add structured logging for walkthrough stream errors

**Description:** As an operator, I want walkthrough SSE errors logged with correlation IDs, so that I can trace failures across the pipeline.

**Acceptance Criteria:**

- [ ] Every `logError` on the walkthrough emit path (`WalkthroughJobs.ts` `emitEvent` + the `Broadcaster` global-bus broadcast) includes `walkthroughId`.
- [ ] Emit drops / fan-out errors include the event type being processed.
- [ ] Prerender failures include the block index.
- [ ] Logs are queryable by `walkthroughId` in development (`REV_DEBUG=1`).

### US-008: Add health-check endpoint with dependency status

**Description:** As an operator, I want a health endpoint that reports DB and GitHub connectivity, so that I can detect outages quickly.

**Acceptance Criteria:**

- [ ] `GET /api/health` returns `{ status: "ok", db: "connected", github: "reachable" }`.
- [ ] If DB is unreachable, returns `503` with `{ status: "error", db: "unreachable" }`.
- [ ] If GitHub API is unreachable (via a lightweight ping), returns `503` with `{ github: "unreachable" }`.
- [ ] Endpoint is unauthenticated (or uses a lightweight check).

## Functional Requirements

- FR-1: Store modules must have unit tests for deduplication, auth transitions, and SSE reconnect.
- FR-2: PR and review routes must have integration tests for limits, rate limiting, and authz.
- FR-3: Walkthrough pipeline must have a smoke test for status transitions.
- FR-4: Walkthrough errors must include correlation IDs in logs.
- FR-5: A `/api/health` endpoint must report DB and GitHub status.

## Non-Goals

- 100% code coverage.
- End-to-end (E2E) tests with Tauri desktop automation.
- Performance/load testing.
- Adding a metrics pipeline (Prometheus/Grafana).

## Technical Considerations

- Use `bun:test` for all tests (Bun's native test runner).
- Use an in-memory SQLite DB (`:memory:`) for server integration tests.
- Mock `fetch` for GitHub API calls in integration tests.
- Mock `EventSource` for `events.svelte.ts` tests (a lightweight fake that can emit `message` / `heartbeat` / `error` events and advance the watchdog clock).
- Follow existing file naming: `<module>.test.ts`.

## Success Metrics

- `bun test` runs successfully and reports ≥10 passing tests.
- The duplicate PR bug has a regression test.
- The reconnect loop bug has a regression test.
- The half-logout bug has a regression test.
- `/api/health` returns 200 when the server is healthy.
- `make typecheck && make lint` passes.

## Open Questions

- Should tests run in CI on every PR, or only on demand?
- Should we add a `make test` command to the Makefile?
- Should integration tests use the real DB schema migrations, or a stripped-down setup?
