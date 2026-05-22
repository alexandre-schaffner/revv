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

### US-002: Move WebSocket token out of query string

**Description:** As a user, I want my bearer token to stay out of server access logs and browser history, so that a log breach does not compromise my session.

**Acceptance Criteria:**

- [ ] `apps/web/src/lib/stores/ws.svelte.ts` no longer appends `?token=` to the WebSocket URL.
- [ ] Client sends token in the first WebSocket message after handshake: `{ type: "auth", token }`.
- [ ] `apps/server/src/routes/ws.ts` accepts the initial `auth` message and validates the token there; rejects connection if token is missing or invalid.
- [ ] Existing `?token=` query-param path is removed or returns `4001` close code.
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

### US-005: Close WebSocket on unresolved account

**Description:** As an operator, I want WebSocket connections with invalid tokens to be closed immediately, so that unauthenticated clients cannot trigger expensive sync operations.

**Acceptance Criteria:**

- [ ] `apps/server/src/routes/ws.ts` closes the connection with code `4001` and reason `"Unauthorized"` when `TokenProvider.resolveAccount` throws.
- [ ] `accountId = "unresolved"` fallback is removed.
- [ ] Client receives a clear close event and stops retrying with the same token.
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
- FR-2: WebSocket auth must happen post-handshake, not via query param.
- FR-3: All user-configurable hostnames/URLs must be validated against strict patterns.
- FR-4: All filesystem-bound user inputs must be path-traversal-checked.
- FR-5: Unauthenticated WebSocket connections must be rejected before any message handling.
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
