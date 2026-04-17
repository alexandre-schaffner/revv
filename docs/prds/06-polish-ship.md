# PRD-06: Polish, Performance & Ship

## Priority: P2 (Ship quality)

## Dependencies: PRD-01 through PRD-05

## Estimated: 6-8 days

---

## Objective

Make Revv production-grade: complete the keyboard-first experience, expand the command palette, optimize performance for large PRs, add offline support, build an onboarding flow, wire up system tray with notifications, and sign/notarize for macOS distribution.

---

## Current State

Several polish items are already partially done:

- **Command palette**: `Cmd+K` works with fuzzy search; theme, sidebar, and panel commands registered
- **Keyboard shortcuts**: `Cmd+B` (sidebar), `Cmd+R` (panel), `Cmd+K` (palette) work
- **Theme system**: light/dark/system with independent diff theme — fully functional
- **`registerCommand()`**: extensible command registry exists

**What's missing:** Full keyboard navigation (j/k in sidebar, n/p in diff), contextual command palette entries (PRs, files, actions), virtualized scrolling for large diffs, offline mode, onboarding, system tray, auto-update, app signing.

---

## Keyboard Shortcut System

### Global

| Shortcut      | Action                               |
| ------------- | ------------------------------------ |
| `Cmd+K`       | Command palette _(already works)_    |
| `Cmd+,`       | Open settings                        |
| `Cmd+Shift+S` | Sync PRs                             |
| `Cmd+B`       | Toggle sidebar _(already works)_     |
| `Cmd+R`       | Toggle right panel _(already works)_ |
| `Escape`      | Close palette / cancel / collapse    |
| `?`           | Show keyboard shortcut cheat sheet   |

### Sidebar

| Shortcut  | Action                   |
| --------- | ------------------------ |
| `j` / `k` | Move selection down / up |
| `Enter`   | Open selected PR         |
| `/`       | Focus search bar         |
| `Escape`  | Clear search, unfocus    |

### Review — Diff Tab

| Shortcut    | Action                             |
| ----------- | ---------------------------------- |
| `1` / `2`   | Switch to Walkthrough / Diff tab   |
| `n` / `p`   | Next / previous file               |
| `j` / `k`   | Next / previous hunk (within file) |
| `c`         | Comment on focused line            |
| `e`         | Explain focused line               |
| `a`         | Accept focused hunk                |
| `x`         | Reject focused hunk                |
| `Cmd+Enter` | Submit comment                     |
| `Escape`    | Close comment / collapse thread    |

### Review — Walkthrough Tab

| Shortcut  | Action                        |
| --------- | ----------------------------- |
| `←` / `→` | Previous / next step          |
| `1` / `2` | Switch tabs                   |
| `c`       | Comment on focused code block |

### Review — Agent

| Shortcut      | Action                    |
| ------------- | ------------------------- |
| `Cmd+Shift+P` | Trigger post-review agent |

### Implementation

- **Centralized manager**: `lib/utils/shortcuts.svelte.ts` — already has foundation, needs context-awareness
- **Context stack**: sidebar | review-diff | review-walkthrough | modal | palette — shortcuts only fire in their context
- **Input guard**: shortcuts disabled when focus is in `<input>`, `<textarea>`, or `contenteditable`
- **Cheat sheet**: `?` opens a modal overlay listing all shortcuts grouped by context
- **Tooltips**: shortcut hints shown in button tooltips (e.g., hover "Sync" → "Sync PRs (⌘⇧S)")

---

## Command Palette Expansion

The palette already works with fuzzy search. Expand it:

### Dynamic Command Sources

| Category       | Source                                 | When Available             |
| -------------- | -------------------------------------- | -------------------------- |
| PRs            | All PRs from `prs.svelte.ts` store     | Always                     |
| Files          | Changed files in current PR            | When in review view        |
| Actions        | Global actions (sync, settings, theme) | Always                     |
| Review Actions | Comment, explain, accept/reject, agent | When in review view        |
| Navigation     | Jump to walkthrough step N             | When walkthrough is loaded |

### Registration Pattern

Each view registers its commands on mount and deregisters on unmount:

```typescript
// In a review component
onMount(() => {
  const unregister = registerCommand({
    id: "review:next-file",
    label: "Next File",
    category: "Review",
    shortcut: "N",
    action: () => goToNextFile(),
  });
  return unregister;
});
```

### Recently Used

Track recently selected commands in localStorage. Show them first when palette opens with empty query.

---

## Performance Optimization

### Virtualized Diff Scrolling

Diffs with 500+ lines need virtualized rendering:

- Only render visible lines + a buffer zone (±50 lines)
- Use Intersection Observer or a virtual scroll container
- Gutter annotations and comment threads must work within virtualized list
- Target: 60fps scroll on a 2000-line unified diff

### Lazy File Loading

- Don't fetch all file diffs on PR open — fetch on-demand when user selects a file
- File tree shows metadata immediately (file name, +/- counts) from the PR files endpoint
- Diff content loads when file is selected
- Prefetch the next file in the tree for instant switching

### Async Syntax Highlighting

- Shiki highlighting can block the main thread on large files
- Run highlighting in a Web Worker or use `requestIdleCallback` to avoid jank
- Show unhighlighted diff immediately, enhance with highlighting when ready

### Caching Strategy

| Data                | Cache Location           | Invalidation                      |
| ------------------- | ------------------------ | --------------------------------- |
| PR list             | Svelte store + SQLite    | On sync                           |
| File diffs          | In-memory per session    | On file switch (LRU, keep last 5) |
| File content        | `fileContentCache` table | On new commits (SHA check)        |
| Walkthrough         | `walkthroughs` table     | On new commits (SHA check)        |
| Shiki grammars      | In-memory singleton      | Never (loaded once)               |
| Explanation history | Svelte store             | On PR switch                      |

### Performance Targets

| Metric                   | Target                 |
| ------------------------ | ---------------------- |
| App launch → interactive | < 2 seconds            |
| PR list render (100 PRs) | < 500ms                |
| Diff render (500 lines)  | < 1 second             |
| Diff scroll (2000 lines) | 60fps                  |
| Walkthrough first step   | < 3 seconds (AI-bound) |
| File switch in diff      | < 300ms                |

---

## Offline Mode

### Behavior

All previously viewed data is already in SQLite. Offline mode extends this:

- **Detection**: `navigator.onLine` + periodic ping to localhost:45678
- **Sidebar**: shows cached PRs with subtle "offline" indicator; sync button disabled
- **Diff view**: works fully from cache (file diffs and content cached)
- **Walkthrough**: cached walkthroughs display; regenerate disabled
- **Comments**: can be created locally (saved to SQLite immediately)
- **Sync**: queued actions replay automatically when connection returns

### Action Queue (Outbox)

```sql
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,        -- 'create_thread' | 'add_message' | 'resolve_thread' | 'push_to_github'
  payload TEXT NOT NULL,            -- JSON: the full request body
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | synced | failed
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT
);
```

When online, a background job drains the outbox in order. Failed items retry with exponential backoff (max 3 retries). Conflicts: last-write-wins with user notification.

---

## Onboarding Flow

First-time wizard shown when no settings are configured:

### Steps

1. **Welcome** — "Revv: AI-powered code review" + [Get Started]
2. **Sign in with GitHub** — OAuth button → Better Auth flow → shows "Connected as @username"
3. **Add Repositories** — search by name, select repos, bulk add
4. **AI Setup** — Anthropic API key input with validation → shows model selector
5. **Ready** — "Your PRs are syncing now" → [Open Revv]

### Implementation

- Route: `/onboarding` — multi-step wizard component
- After completion, redirect to main app
- Settings page always accessible to change these later
- Skip button on AI setup (can be configured later)

---

## System Tray

### Behavior

- Revv icon in macOS menu bar
- Badge count: number of PRs with threads pending the user
- Click: bring Revv window to front
- Right-click menu:
  - Open Revv
  - Sync Now
  - ── separator ──
  - Quit Revv

### Implementation

- Use Tauri's tray API (`tauri-plugin-tray`)
- Badge count updated on each sync cycle
- Icon: monochrome Revv logo SVG (fits macOS menu bar style)

### Native Notifications

Via Tauri notification API:

- "New reply on PR #142" — when sync detects replies on pending threads
- "Sync complete: 3 new PRs" — after background sync finds new PRs
- Respect system notification preferences (can be disabled in settings)

---

## Auto-Update

- Tauri's built-in updater plugin (`tauri-plugin-updater`)
- Check on launch + every 6 hours
- UI: toast notification "Update available — restart to apply"
- Download in background, apply on next restart
- Update manifest hosted on GitHub Releases

---

## App Signing & Distribution

### macOS

- Apple Developer certificate for code signing
- Notarization via `notarytool` (required for Gatekeeper)
- DMG installer with custom background image

### CI Pipeline (`release.yml`)

1. Version bump from git tag
2. Build SvelteKit: `bun run build` in `apps/web`
3. Bundle Elysia server: `bun build` in `apps/server`
4. Build Tauri: Rust compile + bundle frontend + sidecar
5. Sign + notarize
6. Create DMG
7. Upload to GitHub Releases
8. Update auto-update manifest JSON

### Signing Secrets (GitHub Actions)

- `APPLE_CERTIFICATE` (base64)
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_ID` (for notarization)
- `APPLE_TEAM_ID`
- `APPLE_APP_PASSWORD` (app-specific password)
- `TAURI_SIGNING_PRIVATE_KEY` (for update signature)

---

## Acceptance Criteria

- [ ] All keyboard shortcuts work correctly per the tables above
- [ ] `?` opens keyboard shortcut cheat sheet overlay
- [ ] Shortcuts are context-aware (sidebar shortcuts don't fire in review, etc.)
- [ ] Shortcuts disabled in text inputs
- [ ] Command palette shows PRs, files, and actions with fuzzy search
- [ ] Recently used commands appear first in empty palette
- [ ] 2000-line diff scrolls at 60fps (virtualized)
- [ ] File switching in diff takes < 300ms
- [ ] App opens and becomes interactive in < 2 seconds
- [ ] Offline: cached PRs accessible, comments queue, sync on reconnect
- [ ] Onboarding: first-time user sets up GitHub + AI in under 2 minutes
- [ ] System tray shows badge count, click opens app
- [ ] Native notifications for new thread replies
- [ ] Auto-update detects new version and offers install
- [ ] macOS build: signed, notarized, installs from DMG without Gatekeeper warnings
- [ ] No unhandled errors — all error states have clear UI messages
- [ ] `bun run typecheck` passes
