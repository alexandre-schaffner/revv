# Audit PRD: Frontend State Management & Reliability

## Introduction

The frontend audit uncovered 6 critical bugs and 8 high-severity reliability issues in `apps/web/src/lib/stores/` and component layers. These bugs cause data duplication, auth-state corruption, race conditions, and silent failures. This PRD groups them into fixable stories.

## Goals

- Eliminate duplicate data in PR lists.
- Prevent auth-state desync (half-logout, reconnect loops, avatar loss).
- Remove race conditions from async store actions.
- Ensure all network failures surface user-visible feedback.
- Prevent memory leaks from orphaned timers.

## User Stories

### US-001: Fix `mergePullRequests` duplicate PR bug

**Description:** As a user, I want the PR list to remain deduplicated after WebSocket updates, so that I don't see the same PR multiple times.

**Acceptance Criteria:**

- [ ] `apps/web/src/lib/stores/prs.svelte.ts:184` uses `const existingIds = new Set(pullRequests.map((pr) => pr.id));`.
- [ ] Membership test `existingIds.has(pr.id)` correctly prevents duplicates.
- [ ] After receiving `prs:updated` multiple times, `pullRequests` array length is stable.
- [ ] `make typecheck` passes.

### US-002: Fix `disconnect()` → reconnect loop

**Description:** As a user, I want signing out to stop all WebSocket activity, so that the app does not spam reconnection attempts with a cleared token.

**Acceptance Criteria:**

- [ ] `apps/web/src/lib/stores/ws.svelte.ts` declares `let intentionalDisconnect = false`.
- [ ] `disconnect()` sets `intentionalDisconnect = true` before closing the socket.
- [ ] `onClose` handler checks `if (intentionalDisconnect)` and skips `scheduleReconnect()`.
- [ ] After `signOut()`, no WebSocket connection attempts occur for ≥5 seconds.
- [ ] `make typecheck` passes.

### US-003: Fix `applyUserUpdate` avatar loss

**Description:** As a user, I want my avatar to persist across `user:updated` messages, so that it doesn't flash or disappear.

**Acceptance Criteria:**

- [ ] `apps/web/src/lib/stores/auth.svelte.ts:349-366` spreads `...user` into the next state object.
- [ ] Partial updates that omit `image` do not wipe the existing avatar.
- [ ] `make typecheck` passes.

### US-004: Harden `removeAccount` against network failures

**Description:** As a user, I want sign-out to complete locally even if the network is down, so that I'm not left in a half-authenticated state.

**Acceptance Criteria:**

- [ ] `removeAccount()` wraps the `DELETE` fetch in `try/finally`.
- [ ] `sync.stopPolling()`, `ws.disconnect()`, `clearToken()`, and `prs.reset()` always execute in the `finally` block.
- [ ] On network failure, the UI returns to the unauthenticated state.
- [ ] `make typecheck` passes.

### US-005: Handle 401 on identity endpoint as session-invalid

**Description:** As a user, I want an expired or revoked token to trigger automatic sign-out, so that I don't see endless 401 errors on every API call.

**Acceptance Criteria:**

- [ ] `apps/web/src/lib/stores/auth.svelte.ts:300-325` checks `if (res.status === 401)` and calls `clearToken()`.
- [ ] Any non-OK identity response (401/403/500) is treated as session-invalid.
- [ ] After clearing, the app shows the sign-in screen.
- [ ] `make typecheck` passes.

### US-006: Fix `loadChatHistory` optimistic loaded flag

**Description:** As a user, I want to retry loading chat history after a transient network error, so that the chat panel isn't permanently empty.

**Acceptance Criteria:**

- [ ] `apps/web/src/lib/stores/chat.svelte.ts:512-535` moves `markLoaded(prId)` to **after** a successful `fetchChatMessages` response.
- [ ] On failure, `loadedPrIds` is **not** modified.
- [ ] A subsequent `loadChatHistory(prId)` call retries the fetch.
- [ ] `make typecheck` passes.

### US-007: Add atomic guards to async store actions

**Description:** As a user, I want rapid double-clicks to be ignored, so that I don't accidentally pin a PR twice or switch accounts twice.

**Acceptance Criteria:**

- [ ] `auth.svelte.ts:switchAccount` uses an in-flight promise map; second call returns the existing promise.
- [ ] `prs.svelte.ts:fetchMoreArchived` uses `archivedLoadingMore` as an atomic promise.
- [ ] `prs.svelte.ts:pinPr/unpinPr` uses a `Map<prId, Promise<void>>` for in-flight state.
- [ ] `review.svelte.ts:pullLatestCommit` uses a promise-map guard.
- [ ] `chat.svelte.ts:submitQuestionAnswers` uses a promise-map guard.
- [ ] `make typecheck` passes.

### US-008: Fix `+layout.svelte` `setTimeout` leak

**Description:** As a developer, I want HMR remounts to not leak duplicate updater timers, so that the app doesn't accumulate background jobs.

**Acceptance Criteria:**

- [ ] `apps/web/src/routes/+layout.svelte:111-119` stores `const timeoutId = setTimeout(...)`.
- [ ] The `$effect` cleanup function calls `clearTimeout(timeoutId)`.
- [ ] `make typecheck` passes.

### US-009: Surface errors from `hydrate()` in layout

**Description:** As a user, I want to see a visible error when initial data loading fails, so that I know the app is broken rather than just empty.

**Acceptance Criteria:**

- [ ] `apps/web/src/routes/+layout.svelte:89-99` adds `.catch(err => { showErrorBanner(err); })` to `hydrate()`.
- [ ] The error banner uses the existing `ErrorBanner` component or a toast.
- [ ] `make typecheck` passes.

### US-010: Fix `getPrWalkthroughStatus` empty-summary edge case

**Description:** As a user, I want a walkthrough with an explicitly empty summary to still show as complete if blocks/ratings are present.

**Acceptance Criteria:**

- [ ] `apps/web/src/lib/stores/walkthrough.svelte.ts:329-336` checks `entry.summary !== null` instead of truthiness.
- [ ] A walkthrough with `summary: ""` but non-empty blocks returns `"complete"`.
- [ ] `make typecheck` passes.

## Functional Requirements

- FR-1: PR deduplication must use a `Set<string>` of IDs, not arrays.
- FR-2: WebSocket disconnect must be intentional-disconnect-aware.
- FR-3: User state updates must preserve existing fields via spread.
- FR-4: Destructive operations (removeAccount) must complete locally regardless of network.
- FR-5: 401 responses from identity must trigger sign-out.
- FR-6: Chat history loaded-flag must be optimistic only after success.
- FR-7: Async store actions must use promise-map atomic guards.
- FR-8: All module-level timers created in `$effect` must be cleared on cleanup.
- FR-9: Async `hydrate()` failures must surface user-visible errors.
- FR-10: Walkthrough status must distinguish `null` from empty string.

## Non-Goals

- Rewriting all stores to use a new state-management library.
- Adding full runtime validation (zod) to all API boundaries.
- Implementing optimistic UI rollback for every store action.

## Technical Considerations

- Follow existing Svelte 5 rune patterns (`$state`, Map reactivity via reassignment).
- Follow existing store conventions: singleton module + `getX`/`setX` exports.
- Reuse existing `ErrorBanner` component for error surfacing.

## Success Metrics

- PR list length is stable after repeated WS updates.
- Sign-out stops all network activity (verified in Network tab).
- Avatar persists after partial `user:updated` WS messages.
- Double-clicking "Pin" sends exactly one request.
- HMR remount does not duplicate `setInterval` timers.
- `make typecheck && make lint` passes.

## Open Questions

- Should promise-map guards include a timeout/cancellation mechanism?
- Should `fetchPrs` also surface a toast on failure, or just the error banner?
