# PRD-06: Polish, Performance & Ship

## Status: **PARTIAL (~50%)**
## Priority: P2 (Ship quality)
## Dependencies: PRD-01 through PRD-05
## Original estimate: 6-8 days  |  Last updated: 2026-05-16

---

## Objective

Make Revv production-grade: complete the keyboard-first experience, expand the command palette, optimize performance for large PRs, add offline support, finish onboarding, wire up system tray + notifications, and sign/notarize for distribution.

This PRD inherits a number of emergent features that shipped without their own spec — onboarding, multi-account auth, GHE-default support, system tray, auto-start, auto-update infrastructure, CI. They're documented inline below, in the section they fit best. See also `07-emergent-features.md` for the cross-link index.

---

## 1. Keyboard shortcuts

### Status: **PARTIAL**

### Shipped (`apps/web/src/lib/stores/shortcuts.svelte.ts`)

| Shortcut       | Action                  |
| -------------- | ----------------------- |
| `Cmd+P`        | PR search (palette)     |
| `Cmd+Shift+P`  | Command palette         |
| `Cmd+B`        | Toggle sidebar          |
| `Cmd+R`        | Toggle right panel      |
| `Cmd+W`        | Close PR / view         |
| `Cmd+,`        | Open settings           |
| `Cmd+1/2/3`    | Switch tabs             |
| `j` / `k`      | Sidebar navigation      |

Focus tracking: `apps/web/src/lib/stores/focus-mode.svelte.ts` tracks the focused entity for j/k movement in the sidebar (`Sidebar.svelte`, `PierreFileTree.svelte`).

### Remaining (original spec, still in scope)

#### Global

| Shortcut      | Action                               | Status |
| ------------- | ------------------------------------ | ------ |
| `Cmd+Shift+S` | Sync PRs                             | TODO   |
| `Escape`      | Close palette / cancel / collapse    | TODO (partial — works in palette only) |
| `?`           | Show keyboard shortcut cheat sheet   | TODO   |

#### Sidebar

| Shortcut  | Action                   | Status |
| --------- | ------------------------ | ------ |
| `Enter`   | Open selected PR         | TODO   |
| `/`       | Focus search bar         | TODO   |
| `Escape`  | Clear search, unfocus    | TODO   |

#### Review — Diff Tab

| Shortcut    | Action                             | Status |
| ----------- | ---------------------------------- | ------ |
| `n` / `p`   | Next / previous file               | TODO   |
| `j` / `k`   | Next / previous hunk (within file) | TODO   |
| `c`         | Comment on focused line            | TODO   |
| `a` / `x`   | Accept / reject focused hunk       | TODO   |
| `Cmd+Enter` | Submit comment                     | TODO   |
| `Escape`    | Close comment / collapse thread    | TODO   |

The `e` (explain) shortcut from the original spec is no longer applicable — see PRD-02 (Chat Agent); explanation is via chat.

#### Review — Walkthrough Tab

| Shortcut  | Action                        | Status |
| --------- | ----------------------------- | ------ |
| `←` / `→` | Previous / next section       | TODO (handler exists in `walkthroughNav.svelte.ts`; not wired) |
| `c`       | Comment on focused code block | TODO   |

#### Review — Agent

The `Cmd+Shift+P` agent shortcut is **dropped** — chat is always-on (PRD-02), so there's no separate trigger.

### Implementation (remaining)

- **Context awareness**: shortcuts currently fire globally; need a "focus stack" (sidebar | review-diff | review-walkthrough | modal | palette) so keys only fire in their context
- **Input guard**: disable shortcuts when focus is in `<input>`, `<textarea>`, or `contenteditable`
- **Cheat sheet**: `?` opens an overlay listing all shortcuts grouped by context
- **Tooltips**: button tooltips show their shortcut (e.g., hover "Sync" → "Sync PRs (⌘⇧S)")

---

## 2. Command palette

### Status: **SHIPPED (core) · PARTIAL (categories)**

### Shipped (`apps/web/src/lib/components/layout/CommandPalette.svelte`, `apps/web/src/lib/stores/commands.svelte.ts`)

- Fuzzy search + scoring
- Mode-switching via `>` prefix (`search` ↔ `command`)
- PRs and core actions (theme, sidebar, panel) registered via `registerCommand()`

### Remaining

| Category       | Source                                 | When Available             | Status |
| -------------- | -------------------------------------- | -------------------------- | ------ |
| Files          | Changed files in current PR            | When in review view        | TODO   |
| Review Actions | Comment, accept/reject, sync           | When in review view        | TODO   |
| Navigation     | Jump to walkthrough section N          | When walkthrough is loaded | TODO   |
| Recently used  | localStorage-backed                    | When palette opens empty   | TODO   |

Each view should register its commands on mount and deregister on unmount (`registerCommand({ id, label, category, shortcut, action })`).

---

## 3. Onboarding flow

### Status: **SHIPPED**

### What we built (`apps/web/src/lib/components/onboarding/`)

A 5-step wizard:

1. **Welcome** — `StepWelcome.svelte`
2. **Host** — `StepHost.svelte` — choose GHE (default: `nocturlab.ghe.com`) vs `github.com`
3. **Sign in** — `StepSignIn.svelte` — OAuth via Better Auth, deep-link callback on `revv://auth/callback`
4. **Repositories** — `StepRepo.svelte` — search + bulk-add
5. **Done** — `StepDone.svelte` — "your PRs are syncing"

Plus:

- `OnboardingFlow.svelte` — wizard shell; auto-advances on auth state change
- `OnboardingGate.svelte` — gates the main app until onboarding is complete
- `OnboardingShell.svelte` — chrome around the wizard
- `AccountPicker.svelte` — used during sign-in for multi-account selection (see section 4)
- Replay mode — onboarding can be re-entered from settings without losing existing state
- Resume — onboarding survives app restart at any step

Server-side: `apps/server/src/routes/onboarding.ts`, `apps/server/src/routes/device-auth.ts`.

### Drift from original spec

- Host selection (`github.com` vs GHE) is **step 2**, not buried in settings — Revv defaults to `nocturlab.ghe.com` and treats public GitHub as opt-in
- "AI Setup" step from the original spec is **removed** — chat agent credentials follow each agent's own conventions (Claude / opencode), not an API key entry field

---

## 4. Multi-account support

### Status: **SHIPPED**

### What we built (`apps/web/src/lib/stores/auth.svelte.ts`, `apps/server/src/routes/user.ts`)

Two account kinds, both reactive:

- `ConnectedAccount[]` — accounts authenticated against the server (`fetchConnectedAccounts`)
- `LocalAccount[]` — accounts the user has signed into on this device (`fetchLocalAccounts`)

`AccountPicker.svelte` lets the user switch between accounts during onboarding and from the user menu (`apps/web/src/lib/components/sidebar/UserMenu.svelte`). Org filtering (`orgs.svelte.ts`, `OrgSwitcher.svelte`) is account-scoped.

### Drift from original spec

Not in original PRD-06. Added during development to support reviewers who work across multiple GitHub orgs and identities.

---

## 5. GHE / GitHub host configuration

### Status: **SHIPPED**

### What we built

- `apps/server/src/services/Settings.ts` — `githubHost` setting resolved at call time
- `apps/server/src/services/GitHub.ts`, `apps/server/src/services/ChatChangesPush.ts`, `apps/server/src/services/RepoClone.ts` — all GitHub-touching code reads the host at call time, not at module load
- Default: `nocturlab.ghe.com`. `github.com` is opt-in via onboarding step 2 or settings.

### Drift from original spec

Not in original PRD-06. Added because the primary deployment target is GHE; public GitHub is a secondary case.

---

## 6. Performance optimization

### Status: **MOSTLY TODO**

### Virtualized diff scrolling

Diffs with 500+ lines need virtualized rendering. `PierreFileTree.svelte` has a `data-file-tree-virtualized-scroll` attribute, but no virtualization library is wired in.

- Only render visible lines + a ±50-line buffer
- Gutter annotations and comment threads must work within the virtualized list
- Target: 60fps scroll on a 2000-line unified diff

### Lazy file loading

- Don't fetch all file diffs on PR open — fetch on-demand when the user selects a file
- File tree shows metadata (name, +/- counts) immediately from `pr_diff_files`
- Diff content loads when the file is selected
- Prefetch the next file in the tree for instant switching

### Async syntax highlighting

- Shiki highlighting can block the main thread on large files
- Run it in a Web Worker or via `requestIdleCallback`
- Show the unhighlighted diff immediately, enhance when ready

### Caching strategy (mostly shipped via existing services)

| Data                | Cache Location                 | Invalidation                      | Status |
| ------------------- | ------------------------------ | --------------------------------- | ------ |
| PR list             | Svelte store + SQLite          | On sync                           | SHIPPED |
| File diffs          | `pr_diff_files` + in-memory    | On file switch (LRU)              | PARTIAL — table exists, LRU TODO |
| File content        | `file_content_cache` table     | On new commits (SHA check)        | SHIPPED |
| Walkthrough         | `walkthroughs` + cohort tables | On new commits (SHA check, supersede) | SHIPPED |
| Shiki grammars      | In-memory singleton            | Never                             | SHIPPED |
| Prerender HTML      | `PrerenderCache` service       | On block content change           | SHIPPED |

### Performance targets (TODO — none measured)

| Metric                   | Target                 |
| ------------------------ | ---------------------- |
| App launch → interactive | < 2 seconds            |
| PR list render (100 PRs) | < 500ms                |
| Diff render (500 lines)  | < 1 second             |
| Diff scroll (2000 lines) | 60fps                  |
| Walkthrough first event  | < 3 seconds (AI-bound) |
| File switch in diff      | < 300ms                |

---

## 7. Offline mode

### Status: **PARTIAL (read-only works, no outbox)**

Cached PRs, diffs, file contents, walkthroughs are all already in SQLite — offline reads work today. The remaining work is the write path.

### Behavior (target)

- **Detection**: `navigator.onLine` + periodic ping to `localhost:45678`
- **Sidebar**: cached PRs with a subtle "offline" indicator; sync button disabled
- **Diff view**: works fully from cache (shipped)
- **Walkthrough**: cached walkthroughs display; regenerate disabled
- **Comments**: created locally (saved to SQLite immediately) — needs outbox replay
- **Chat agent**: read-only (no agent calls without network); chat history viewable

### Action queue (outbox) — TODO

```sql
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,        -- create_thread | add_message | resolve_thread | push_to_github
  payload TEXT NOT NULL,            -- JSON: the full request body
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | synced | failed
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT
);
```

When online, a background job drains the outbox in order. Failed items retry with exponential backoff (max 3). Conflicts: last-write-wins with user notification.

---

## 8. System tray

### Status: **SHIPPED (basics)**

### What we built (`apps/desktop/src/lib.rs`)

- macOS menu-bar icon with tray menu (Open / Quit)
- Left-click brings window to front
- Close button intercepted → window hides to tray (close-to-tray)
- `tauri_plugin_autostart` registered with `--hidden` flag for login-triggered launches

### Remaining

- [ ] **Badge count** — number of PRs with threads pending the user (requires PRD-04 thread-summary plumbing per account)
- [ ] **Native notifications** — `tauri-plugin-notification` not registered; needed for "new reply on PR #142" and "sync complete: 3 new PRs"
- [ ] **Right-click "Sync Now"** — menu entry exists for Open/Quit; sync action TODO

---

## 9. Auto-update

### Status: **PARTIAL (plugin wired, signing TODO)**

### What we built

- `tauri-plugin-updater` registered (`apps/desktop/src/lib.rs`)
- `apps/desktop/tauri.conf.json` has the updater config

### Remaining

- [ ] **Updater signing** — `release.yml` has the signing step commented out (`# Uncomment when updater signing is configured`); need `TAURI_SIGNING_PRIVATE_KEY` in CI secrets
- [ ] **Auto-update manifest JSON** — not generated by `release.yml` yet; needed for the updater plugin to find new versions
- [ ] **Toast UI** — no "update available, restart to apply" toast wired
- [ ] **Cadence** — original spec called for check-on-launch + every 6h; not yet enforced

---

## 10. App signing & distribution

### Status: **PARTIAL**

### What we built

- `.github/workflows/ci.yml` — lint, typecheck, build on every PR
- `.github/workflows/release.yml` — cross-platform Tauri build (macOS DMG, Windows NSIS, Linux AppImage)
- `tauri.conf.json` — bundle config for all three platforms

### Remaining

#### macOS

- [ ] Apple Developer certificate for code signing
- [ ] Notarization via `notarytool` (required for Gatekeeper)
- [ ] DMG custom background image
- [ ] Signing secrets: `APPLE_CERTIFICATE` (base64), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`

#### Windows

- [ ] Authenticode signing (currently unsigned NSIS installer triggers SmartScreen warnings)

#### Linux

- AppImage builds today without signing — acceptable for v1

---

## 11. Error handling & empty states

### Status: **PARTIAL**

### Shipped

- Empty states in Sidebar, IssuesPanel, and walkthrough (visible in components under `apps/web/src/lib/components/`)
- Onboarding-time error handling (auth failures redirect to retry)
- Per-flow error banners in chat / push paths

### Remaining

- [ ] Top-level error boundary so unhandled errors render a fallback UI instead of a blank screen
- [ ] Consistent error toast UX across the app (rather than per-store ad-hoc handling)

---

## Acceptance criteria

Section-scoped — the "shipped" entries are not re-tested here; this list is what's left.

- [ ] All TODO shortcuts in §1 work; context-awareness prevents cross-context misfires; `?` opens a cheat-sheet overlay
- [ ] Command palette includes Files / Review Actions / Navigation categories when in the relevant context; recently-used commands appear first on empty query
- [ ] 2000-line diff scrolls at 60fps; file switching < 300ms
- [ ] Offline: comments queue to outbox, replay on reconnect with backoff; conflicts surface a notification
- [ ] Tray shows accurate badge count; native notification fires for new replies and sync-complete events
- [ ] Auto-update finds a new release, downloads in the background, prompts a restart toast; manifest JSON is generated by `release.yml`
- [ ] macOS build is signed + notarized; DMG opens without Gatekeeper warnings; updater signature validates
- [ ] No unhandled error renders a blank screen; top-level boundary shows a friendly fallback
- [ ] `make typecheck` and `make lint` pass
