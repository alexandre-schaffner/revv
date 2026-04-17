# Revv — Product Requirements Documents

## Overview

Revv is an AI-powered code review desktop application built with Tauri v2, SvelteKit, Elysia, Effect, and SQLite. These PRDs define the remaining feature scope from the current state of the codebase, broken into sequentially buildable pieces.

## What's Already Built

The foundation is solid. Everything below is implemented and working:

- **Monorepo**: Bun workspaces + Turborepo, TypeScript strict mode (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
- **Desktop**: Tauri v2 window, deep-link handling (`revv://`), sidecar server spawning
- **Server**: Elysia on Bun with full Effect service layer — `GitHubService`, `RepositoryService`, `PullRequestService`, `PollScheduler`, `WebSocketHub`, `Settings`, `TokenProvider`
- **Auth**: Better Auth with GitHub OAuth (bearer token strategy, WebSocket auth via `?token=`)
- **Database**: Drizzle ORM on SQLite — `repositories`, `pullRequests`, `userSettings`, `fileContentCache`, plus Better Auth tables (`user`, `session`, `account`, `verification`)
- **PR Fetching**: Automatic polling (configurable interval), manual sync via WebSocket, broadcasts `prs:updated` / `prs:sync-started` / `prs:sync-complete`
- **Sidebar**: Collapsible repo groups with chevron + PR count badge, fuzzy PR search (debounced), status dots (blue/yellow/green/purple/gray)
- **Diff View**: `@pierre/diffs` rendering with unified + split modes, file tree navigation, syntax highlighting
- **Hunk Accept/Reject**: Reviewers can approve or flag individual hunks — tracked per-file in the review store (not in original PRDs, a positive addition)
- **Comment UI**: Inline comment input (`AnnotationCommentInput`), thread display (`AnnotationThread`), code suggestion application — all in-memory only, lost on refresh
- **Right Panel**: Shell exists with `ExplanationEntry` infrastructure (streaming state: `startExplanation`, `appendExplanationChunk`, `finishExplanation`), but no AI endpoint wired
- **Command Palette**: `Cmd+K` with fuzzy search, theme/sidebar/panel commands registered via `registerCommand()`
- **Theme System**: Light/dark/system with independent diff theme preference (sync/light/dark)
- **Token Hover**: `TokenTooltip` showing code token context on hover in diff view
- **Settings Page**: AI provider/model config, diff view mode, auto-fetch interval

### Key differences from original PRDs

| Original Plan                             | What Actually Happened                                         |
| ----------------------------------------- | -------------------------------------------------------------- |
| Tauri keychain commands for token storage | Better Auth handles sessions; no Rust keychain commands needed |
| No hunk-level review controls             | Hunk accept/reject system built (positive drift)               |
| No token hover                            | `TokenTooltip` component built                                 |
| Command palette in PRD-06                 | Already implemented with fuzzy search                          |
| Independent diff theme not planned        | Diff theme can diverge from app theme                          |
| `fileContentCache` table not planned      | Added for caching raw file content from GitHub                 |

## Application Layout

```
+--+----------------------------------------------------+--------+
|  | PR Title              [Walkthrough][Diff]   [>]    |        |
|S +----------------------------------------------------+ Right  |
|I |                                                     | Panel  |
|D |                                                     | (AI    |
|E |          Main Content Area                          | context|
|B |          (walkthrough steps or diff view)           | explan-|
|A |                                                     | ations)|
|R |                                                     |        |
+--+-----------------------------------------------------+--------+
```

## PRD Index

| PRD                               | Title                                 | Priority | Dependencies                 | Focus                                                                                   |
| --------------------------------- | ------------------------------------- | -------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| [01](./01-comment-persistence.md) | Comment Persistence & Review Sessions | P0       | None (builds on existing UI) | Wire in-memory comments to SQLite, add review session lifecycle, persist hunk decisions |
| [02](./02-ai-context-panel.md)    | AI Context Panel                      | P0       | PRD-01                       | First AI integration: streaming code explanations in right panel                        |
| [03](./03-ai-walkthrough.md)      | AI Guided Walkthrough                 | P1       | PRD-02                       | Tab 1 content: Claude analyzes PR, streams step-by-step presentation                    |
| [04](./04-github-sync.md)         | GitHub Sync & Conversations           | P1       | PRD-01                       | Bidirectional comment sync, ping-pong thread status machine                             |
| [05](./05-post-review-agent.md)   | Post-Review Agent                     | P1       | PRD-01 through PRD-04        | AI collects all comments, proposes concrete code changes                                |
| [06](./06-polish-ship.md)         | Polish, Performance & Ship            | P2       | PRD-01 through PRD-05        | Keyboard-first, offline, onboarding, auto-update, app signing                           |

## Dependency Graph

```
PRD-01 (Comments + Sessions)
  |
  +-- PRD-02 (AI Context Panel)
  |     |
  |     +-- PRD-03 (AI Walkthrough)
  |           |
  |           +-- PRD-05 (Post-Review Agent)
  |                 |
  |                 +-- PRD-06 (Polish + Ship)
  +-- PRD-04 (GitHub Sync)
        |
        +-- PRD-05
```

PRD-02 and PRD-04 can be built in parallel after PRD-01.

## Tech Stack (Actual)

| Layer          | Technology                                                            |
| -------------- | --------------------------------------------------------------------- |
| Desktop        | Tauri v2 (Rust shell, deep-link plugin, opener plugin)                |
| Frontend       | SvelteKit (Svelte 5 runes, adapter-static SPA) + shadcn-svelte        |
| Diff rendering | @pierre/diffs (vanilla JS, Svelte-wrapped)                            |
| Backend        | Elysia on Bun, Effect for DI/error handling                           |
| Database       | SQLite via Drizzle ORM (schema applied directly, no migration runner) |
| Auth           | Better Auth with GitHub OAuth                                         |
| AI             | Anthropic Claude (configured in settings, not yet integrated)         |
| Styling        | Tailwind CSS v4                                                       |
| Real-time      | Bun native WebSocket + custom WebSocketHub                            |
| Type safety    | Eden treaty client (Elysia type-safe RPC)                             |
