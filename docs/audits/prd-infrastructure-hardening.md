# Audit PRD: Dependency & Infrastructure Hardening

## Introduction

The dependency audit identified 23 vulnerabilities, version mismatches, invalid configuration schemas, and dead dependencies. These issues affect security, build reliability, and runtime stability. This PRD groups infrastructure fixes into implementable stories.

## Goals

- Resolve all high-severity dependency vulnerabilities.
- Fix version mismatches and peer-dependency violations.
- Clean dead dependencies and invalid configuration.
- Align `bun-types` with the declared runtime version.

## User Stories

### US-001: Fix `tauri.conf.json` schema URL

**Description:** As a developer, I want the Tauri configuration validated against the correct schema, so that IDEs and build tools catch config errors early.

**Acceptance Criteria:**

- [ ] `apps/desktop/tauri.conf.json` `$schema` points to a valid Tauri v2 schema URL (e.g., `https://schema.tauri.app/config/2`).
- [ ] The `nickel.rs` URL is removed.
- [ ] VS Code / Zed shows autocomplete and validation for Tauri config keys.
- [ ] `bunx tauri build` still succeeds.

### US-002: Replace updater `pubkey` placeholder

**Description:** As an operator, I want the auto-updater to verify signatures, so that users cannot be tricked into installing malicious builds.

**Acceptance Criteria:**

- [ ] `apps/desktop/tauri.conf.json` `plugins.updater.pubkey` contains the actual Minisign public key.
- [ ] Placeholder `"REPLACE_WITH_MINISIGN_PUBLIC_KEY"` is removed.
- [ ] Auto-updater signature verification succeeds in a test build.
- [ ] Build pipeline docs are updated with instructions for key rotation.

### US-003: Remove unused `@tauri-apps/plugin-process`

**Description:** As a developer, I want dead dependencies removed, so that the bundle size and attack surface are minimized.

**Acceptance Criteria:**

- [ ] `apps/web/package.json` no longer lists `@tauri-apps/plugin-process`.
- [ ] `bun.lockb` is regenerated and the package is removed from the lockfile.
- [ ] `make typecheck` and `make lint` pass.

### US-004: Remove `elysia` from web `devDependencies`

**Description:** As a developer, I want server-only frameworks out of the frontend package, so that dependency trees remain clean.

**Acceptance Criteria:**

- [ ] `apps/web/package.json` no longer lists `elysia`.
- [ ] If Eden needs it transitively, it remains in the lockfile as an indirect dependency only.
- [ ] `make typecheck` and `make lint` pass.

### US-005: Fix `packages/app` `@types/node` version

**Description:** As a developer, I want valid type definitions, so that TypeScript doesn't reference non-existent Node.js APIs.

**Acceptance Criteria:**

- [ ] `packages/app/package.json` `@types/node` is `^22.0.0` (not `^25.6.0`).
- [ ] `bun install` succeeds.
- [ ] `make typecheck` passes for `packages/app`.

### US-006: Align `bun-types` with declared packageManager

**Description:** As a developer, I want type definitions that match the runtime, so that I don't use APIs that don't exist in production.

**Acceptance Criteria:**

- [ ] All `bun-types` entries in `apps/server/package.json` and `apps/web/package.json` match the repo's declared `packageManager` (`bun@1.3.4`).
- [ ] If `bun@1.3.4` ships `bun-types@1.3.4`, pin to that. Otherwise use `^1.3.4`.
- [ ] `make typecheck` passes across all packages.

### US-007: Add `lint` to Turbo task graph

**Description:** As a developer, I want linting to benefit from Turbo caching and parallelization, so that CI runs faster.

**Acceptance Criteria:**

- [ ] `turbo.json` defines a `"lint"` task with appropriate `dependsOn` and `outputs`.
- [ ] `make lint` runs `turbo run lint` instead of `biome ci .` directly.
- [ ] Repeated lint runs with no changes are cached by Turbo.

### US-008: Resolve dual `zod` major versions

**Description:** As an operator, I want a single `zod` major version in the dependency tree, so that type duplication and bundle bloat are avoided.

**Acceptance Criteria:**

- [ ] `bun.lockb` contains only one major version of `zod`.
- [ ] If `@tanstack/*` packages require `zod@3.x`, consider downgrading the direct dependency or using `zod@3.x` everywhere.
- [ ] `make typecheck` passes.

### US-009: Remove `ws://localhost:9223` from production CSP

**Description:** As a user, I want the Tauri CSP to be as restrictive as possible, so that production builds don't allow unnecessary connections.

**Acceptance Criteria:**

- [ ] `apps/desktop/tauri.conf.json` `connect-src` does not include `ws://localhost:9223` in production.
- [ ] Dev-only CSP entries are gated behind a conditional or dev-specific config file.
- [ ] `bunx tauri build` produces a CSP without the devtools port.

## Functional Requirements

- FR-1: Tauri config must validate against the official Tauri schema.
- FR-2: Updater `pubkey` must be a real Minisign public key.
- FR-3: Dead dependencies must be removed from `package.json` files.
- FR-4: Server-only frameworks must not be direct dependencies of the web app.
- FR-5: `@types/node` must reference an existing Node.js version.
- FR-6: `bun-types` must match the declared `packageManager` runtime.
- FR-7: `lint` must be a Turbo-cached task.
- FR-8: Only one `zod` major version may exist in the lockfile.
- FR-9: Production CSP must exclude dev-only endpoints.

## Non-Goals

- Migrating from Biome to ESLint/Prettier.
- Replacing Bun with Node.js or pnpm.
- Adding a dependency vulnerability scanner to CI (consider future work).
- Changing the Tauri bundle format (DMG/MSI/DEB).

## Technical Considerations

- Ensure `bun install` regenerates `bun.lockb` cleanly after removals.
- Test `make build` after dependency changes—Drizzle upgrades may require migration adjustments.
- The updater pubkey should be stored in a secure secret manager, not hardcoded, if possible.

## Success Metrics

- `bun audit` shows 0 high-severity advisories.
- `bun.lockb` contains only one `zod` major version.
- `make lint` uses Turbo and benefits from caching.
- `make build` succeeds after all changes.
- Tauri config validates in VS Code with correct schema.

## Open Questions

- Where is the Minisign private key stored for updater signing?
- Should we add `bun audit` to the CI pipeline or pre-commit hooks?
- Is `packages/app` actively maintained, or should it be removed entirely?
