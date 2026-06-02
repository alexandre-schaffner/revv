# Audit PRD: Security Hardening

## Introduction

The 2026-05-20 security audit uncovered 2 critical vulnerabilities, 7 high-severity issues, and 23 dependency vulnerabilities (6 high) in the Revv codebase. This PRD groups the security-related findings into discrete, implementable stories.

## Goals

- Eliminate cross-origin authentication bypass vectors.
- Remove credentials and tokens from observable surfaces (URLs, query strings, logs).
- Prevent SSRF, command injection, and path-traversal attacks.
- Upgrade vulnerable dependencies to patched versions.
- Add defense-in-depth validation at all trust boundaries.

## User Stories

### US-001: Fix CORS origin to explicit allowlist

**Description:** As a user, I want my session cookie/bearer token to be inaccessible to malicious third-party sites, so that my Revv account cannot be compromised via cross-origin requests.

**Acceptance Criteria:**

- [ ] `apps/server/src/index.ts` CORS `origin` is an explicit array covering all legitimate app origins: `["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173", "http://localhost:45678", "http://localhost:45679", "tauri://localhost", "https://tauri.localhost"]`.
- [ ] Regex `/localhost/` is removed entirely.
- [ ] Credentials are still allowed for the listed origins.
- [ ] `make typecheck` passes.
- [ ] Manual test: `curl -H "Origin: https://evil.localhost.attacker.com" -I http://localhost:45678/api/prs` returns **no** `Access-Control-Allow-Origin` header.

### US-002: Keep the session bearer token out of the SSE URL

**Description:** As a user, I want my bearer token to stay out of server access logs and browser history, so that a log breach does not compromise my session.

**Context:** The global realtime channel is SSE, not WebSocket. `apps/server/src/routes/events.ts` (`GET /api/events`) authenticates via a `?token=<bearer>` query param because the browser `EventSource` API cannot set custom headers, so the long-lived bearer lands in access logs and history. SSE is unidirectional, so the old "send the token in a post-handshake message" fix is impossible — the bearer must be removed from the URL another way.

**Acceptance Criteria (pick one approach):**

- [ ] **Cookie approach (preferred, pairs with US-008):** session lives in an `httpOnly` cookie; client opens `new EventSource(url, { withCredentials: true })` and `events.ts` reads the cookie instead of `query.token`. No token in the URL at all.
- [ ] **Ticket approach:** client first POSTs (with `Authorization: Bearer`) to mint a short-TTL, single-use SSE ticket, then opens `EventSource?ticket=…`. The ticket is rejected after first use / expiry, so a logged URL is worthless.
- [ ] Either way, the reusable bearer token no longer appears in `GET /api/events` request URLs.
- [ ] `make typecheck` passes.

### US-003: Validate `githubHost` to prevent SSRF

**Description:** As a user, I want the app to reject obviously malicious GitHub Enterprise hostnames, so that my access tokens are not sent to attacker-controlled servers.

**Acceptance Criteria:**

- [ ] `apps/server/src/services/GitHub.ts` validates `githubHost` against `^[a-zA-Z0-9][-a-zA-Z0-9]*(\.[a-zA-Z0-9][-a-zA-Z0-9]*)+$` before constructing API URLs.
- [ ] `apps/server/src/routes/device-auth.ts` applies the same validation before initiating device-code flow.
- [ ] Invalid hostnames fail fast with a tagged `InvalidGitHubHostError` (added to `domain/errors.ts`).
- [ ] `make typecheck` and `biome check` pass.

### US-004: Harden `runGitCapture` and path arguments

**Description:** As a user, I want user-provided file paths to be validated before reaching git commands, so that attackers cannot manipulate git via crafted path inputs.

**Acceptance Criteria:**

- [ ] `apps/server/src/services/RepoClone.ts` validates `path` with regex `^[\w./-]+$` and rejects paths starting with `-` or containing `..`.
- [ ] `assertSafeClonePath` in `RepoClone.ts` uses `path.resolve()` + `path.relative()` to confirm the resolved path is inside `CLONE_BASE_DIR`.
- [ ] Invalid paths return a tagged `CloneError` before `Bun.spawn` is invoked.
- [ ] `make typecheck` and `biome check` pass.

### US-005: Reject unresolved-account SSE connections (or keep them provably inert)

**Description:** As an operator, I want SSE connections that can't be scoped to an account handled safely, so that they neither consume resources nor receive another account's data.

**Context:** `apps/server/src/routes/events.ts` already rejects a missing or invalid token with `401` before registering any writer. The remaining edge is a *valid* session whose account can't be resolved: today it opens an observer-only connection with `accountId = "unresolved"` that receives no scoped broadcasts. Because SSE is server→client only — there is no inbound command channel; sync is triggered solely via REST `POST /api/prs/sync` — an observer connection cannot trigger work, so the original "expensive sync operations" threat no longer applies. This is now low severity.

**Acceptance Criteria:**

- [ ] Decide the policy for an authenticated-but-unresolvable account: either return `401` / close the stream, or keep the inert `"unresolved"` observer connection and document why it's safe (no scoped data, no inbound commands).
- [ ] If closing: `events.ts` returns `401` when `Identity.resolveAccount` throws, and the client stops retrying with the same token.
- [ ] Missing/invalid token continues to return `401` before `Broadcaster.register`.
- [ ] `make typecheck` passes.

### US-006: Sanitize error responses in `handleAppError`

**Description:** As a user, I want the API to return generic error messages, so that internal paths or SQL snippets are not leaked to the client.

**Acceptance Criteria:**

- [ ] `apps/server/src/routes/middleware.ts:133-137` returns `{ error: "Internal server error" }` for all unhandled exceptions.
- [ ] The real `e.message` and stack trace are logged server-side via `logError`.
- [ ] `make typecheck` and `biome check` pass.

### US-007: Upgrade vulnerable dependencies

**Description:** As an operator, I want known-vulnerable packages patched, so that the app is not exposed to public CVEs.

**Acceptance Criteria:**

- [ ] `drizzle-orm` upgraded to `>=0.45.2` (fixes GHSA-gpj5-g38j-94v9 + satisfies `better-auth` peer dep).
- [ ] `drizzle-kit` upgraded to `>=0.31.4` (satisfies `better-auth` peer dep).
- [ ] `marked` upgraded to `>=18.0.2` (fixes GHSA-6v9c-7cg6-27q7).
- [ ] `bun update` run to pull patched transitive deps (`svelte`, `devalue`, `postcss`, `turbo`, `hono`, `esbuild`, etc.).
- [ ] `bun audit` shows **zero** high-severity advisories.
- [ ] `make typecheck` and `make lint` pass after upgrades.
- [ ] Server starts successfully and migrations apply cleanly.

### US-008: Replace `localStorage` token with `httpOnly` cookie

**Description:** As a user, I want my session token stored in an `httpOnly` cookie, so that a future XSS vulnerability cannot exfiltrate it.

**Acceptance Criteria:**

- [ ] Server sets `httpOnly`, `Secure`, `SameSite=Strict` cookie on auth success.
- [ ] Web client no longer reads `rev_session_token` from `localStorage`.
- [ ] API client reads token from a non-`httpOnly` cookie or cookie-less header for Bearer auth (or server reads the `httpOnly` cookie directly).
- [ ] `localStorage` token cleanup code remains for one release as a migration path.
- [ ] `make typecheck` passes.

## Functional Requirements

- FR-1: CORS `origin` must be an explicit allowlist; no regex matching.
- FR-2: The SSE stream must not carry a reusable bearer token in its URL — use an `httpOnly` cookie or a short-lived single-use ticket (`EventSource` cannot send custom headers).
- FR-3: All user-configurable hostnames/URLs must be validated against strict patterns.
- FR-4: All filesystem-bound user inputs must be path-traversal-checked.
- FR-5: Unauthenticated SSE connections must be rejected (`401`) before the writer is registered with the `Broadcaster`.
- FR-6: Server error responses must never include raw exception messages.
- FR-7: `bun audit` must report zero high-severity vulnerabilities.
- FR-8: Session token storage must use `httpOnly` cookies.

## Non-Goals

- Full penetration test or external security audit.
- Replacing `better-auth` with a custom auth system.
- Adding a WAF or DDoS protection layer.
- Changing the OAuth flow from device-code to something else.

## Technical Considerations

- Follow existing Effect service patterns (`Effect.try`, tagged errors).
- Follow existing Svelte 5 store patterns for auth state changes.
- Dependency upgrades may require Drizzle schema or migration adjustments—test thoroughly.

## Success Metrics

- `bun audit` shows 0 high-severity advisories.
- `curl` test from malicious `localhost` subdomain receives no CORS headers.
- Server access logs contain no JWT tokens in query strings.
- `make typecheck && make lint` passes.

## Open Questions

- Do we need to support custom Tauri protocol origins beyond `tauri://localhost`?
- Should the `httpOnly` cookie change be feature-flagged for gradual rollout?
