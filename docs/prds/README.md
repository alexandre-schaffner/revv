# Revv — Product Requirements Documents

## Overview

Revv is an AI-powered code review desktop application built with Tauri v2, SvelteKit, Elysia, Effect, and SQLite. The PRDs below are the historical roadmap; they have been updated to reflect what actually shipped, where reality diverged from the original plan, and what remains in scope.

The agent and walkthrough subsystems are governed by the **"Agent Subsystem Invariants"** section in the repo-root [`CLAUDE.md`](../../CLAUDE.md). Where this README and CLAUDE.md disagree, CLAUDE.md wins.

---

## Status snapshot

| PRD | Title | Status | Notes |
| --- | ----- | ------ | ----- |
| [01](./01-comment-persistence.md) | Comment Persistence & Review Sessions | **SHIPPED (~95%)** | Tiny gaps: indexes, delete guards, automated refresh test |
| [02](./02-chat-agent.md) | Chat Agent | **SHIPPED core · polish PARTIAL** | Replaced original "AI Context Panel" |
| [03](./03-ai-walkthrough.md) | AI Guided Walkthrough | **SHIPPED (~95%)** | 4-phase MCP pipeline; see CLAUDE.md for invariants |
| [04](./04-github-sync.md) | GitHub Sync & Conversations | **Backend SHIPPED · Frontend ~50%** | Badges, sync indicator, reopen UI still TODO |
| [05](./05-chat-driven-changes.md) | Chat-Driven Changes | **SHIPPED core · polish PARTIAL** | Replaced original "Post-Review Agent"; commits-as-proposals + `--force-with-lease` push + AI conflict resolution |
| [06](./06-polish-ship.md) | Polish, Performance & Ship | **PARTIAL (~50%)** | Onboarding/multi-account/GHE/tray SHIPPED; kbd nav, virtualization, offline outbox, signing remaining |
| [07](./07-emergent-features.md) | Emergent Features (index) | n/a | Cross-link index, not a roadmap |

---

## What's already built (high level)

Foundation:

- **Monorepo**: Bun workspaces + Turborepo, TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
- **Desktop shell**: Tauri v2, deep-link (`revv://`), sidecar server, macOS system tray, auto-start, updater plugin wired
- **Server**: Elysia on Bun with a full Effect service layer — `GitHubService`, `RepositoryService`, `PullRequestService`, `PollScheduler`, `WebSocketHub`, `SettingsService`, `TokenProvider`, `ReviewService`, `SyncService`, `WalkthroughService`, `WalkthroughJobs`, `AiService`, `ChatSessionService`, `ChatChangesPushService`, `ChatMcpTokens`, `OpencodeSupervisor`
- **Auth**: Better Auth with GitHub OAuth; multi-account (`ConnectedAccount[]` / `LocalAccount[]`); GHE-default with public `github.com` opt-in
- **Database**: SQLite via Drizzle; schema applied directly (no migration runner). Tables include `review_sessions`, `comment_threads`, `thread_messages`, `hunk_decisions`, `chat_*` (7 tables), `walkthroughs` + 4 walkthrough cohort tables, `pr_diff_files`, `file_content_cache`, `pull_requests`, `repositories`, plus Better Auth tables. `user_settings` was dropped; preferences live in `~/.revv/settings.json`.

Review surface:

- **Sidebar**: collapsible repo groups, org switcher, fuzzy PR search, status dots, j/k navigation, virtualized file tree attribute (no implementation yet)
- **Diff view**: `@pierre/diffs` rendering, unified + split modes, file tree, syntax highlighting, token-hover popover (`TokenTooltip`)
- **Hunk decisions**: persisted accept/reject per file, per hunk, per review session
- **Comments**: persisted threads with status machine, GitHub-sync bidirectional, gutter-marker colors by status, code-suggestion application
- **Walkthrough**: 4-phase MCP-driven generation (Overview → Diff Analysis → Sentiment → 9-axis Rating) with chat-edit post-completion mutations, supersession on new head SHA, resume-on-boot
- **Chat**: always-on right-panel chat agent with plan mode, tool-use streaming, task queue, pending questions, per-PR worktree, proposed-commits strip (cherry-pick / discard / push), AI-driven merge-conflict resolution
- **Right panel**: chat agent surface (not the original "explanation panel"; the explain-code use case was absorbed into chat)
- **Command palette**: `Cmd+P` PR search, `Cmd+Shift+P` command mode (via `>` prefix), fuzzy scoring
- **Theme system**: light/dark/system with independent diff theme preference
- **Settings**: modal with agent/model selection, host config, account management, replayable onboarding

Distribution:

- **CI**: `.github/workflows/ci.yml` (lint, typecheck, build), `.github/workflows/release.yml` (cross-platform Tauri build — DMG, NSIS, AppImage). Updater signing and macOS notarization still TODO.

---

## Application layout

```
+--+----------------------------------------------------+--------+
|  | PR Title              [Walkthrough][Diff]   [>]    |        |
|S +----------------------------------------------------+  Chat  |
|I |                                                     |  Agent |
|D |                                                     | (PRD-02|
|E |          Main Content Area                          |  PRD-05|
|B |          (walkthrough sections or diff view)        |        |
|A |                                                     |        |
|R |                                                     |        |
+--+-----------------------------------------------------+--------+
```

---

## Dependency graph (actual)

```
PRD-01 (Comment Persistence)         ────► foundation for everything
   │
   ├──► PRD-04 (GitHub Sync) ─────────────► consumes threads, exposes role + sync
   │
   ├──► PRD-03 (Walkthrough) ─────────────► 4-phase pipeline; chat-edit tools live in PRD-02 surface
   │       │
   │       └──► chat-edit MCP (shared with PRD-02)
   │
   └──► PRD-02 (Chat Agent) ──────────────► always-on AI surface; MCP, opencode supervisor
           │
           └──► PRD-05 (Chat-Driven Changes) ───► proposed-commits strip + `--force-with-lease` push
                   │
                   └──► PRD-06 (Polish & Ship) ──► keyboard, virtualization, offline, signing
```

PRDs 02 and 05 were substantially reshaped during development; the originals lived as "AI Context Panel" and "Post-Review Agent" respectively. The original `02-ai-context-panel.md` and `05-post-review-agent.md` files were removed when the new direction shipped — `git log -- docs/prds/` recovers the originals if needed.

---

## Emergent features

Features that shipped without their own PRD are folded into the PRDs they touch and indexed in [`07-emergent-features.md`](./07-emergent-features.md):

- Onboarding flow → PRD-06
- Multi-account auth → PRD-06
- GHE-default host → PRD-06
- System tray + close-to-tray → PRD-06
- Opencode supervisor + dual agent paths → PRD-02 / PRD-03
- Chat-edit MCP surface → PRD-03
- Proposed-changes strip → PRD-05
- AI merge-conflict resolution → PRD-05
- Reviewer feedback on proposed commits → PRD-05

---

## Tech stack (actual)

| Layer          | Technology                                                            |
| -------------- | --------------------------------------------------------------------- |
| Desktop        | Tauri v2 (Rust shell, deep-link plugin, opener plugin, autostart, updater, tray) |
| Frontend       | SvelteKit (Svelte 5 runes, adapter-static SPA) + shadcn-svelte + Tailwind CSS v4 |
| Diff rendering | @pierre/diffs (vanilla JS, Svelte-wrapped)                            |
| Backend        | Elysia on Bun, Effect for DI/error handling                           |
| Database       | SQLite via Drizzle ORM (schema applied directly, no migration runner) |
| Auth           | Better Auth with GitHub OAuth; multi-account                          |
| AI             | Claude Agent SDK (in-process) + opencode (HTTP MCP, subprocess); MCP tool handlers shared in-process |
| Real-time      | Bun native WebSocket + custom `WebSocketHub`                          |
| Type safety    | Eden treaty client (Elysia type-safe RPC); shared types in `@revv/shared` |
| Settings       | `~/.revv/settings.json` (not in DB)                                   |
