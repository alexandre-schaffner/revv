# PRD-07: Emergent Features

## Status: **Index, not a roadmap**
## Last updated: 2026-05-16

---

This file indexes features that shipped without their own PRD — they emerged during development as the product direction crystallized. Each entry points to the PRD where the feature is specced in detail.

This is a cross-reference index. There is no work in this PRD; if you're looking for what's left to build, see the individual PRDs.

---

## Onboarding flow

5-step wizard (Welcome → Host → Sign-in → Repositories → Done) with resume across app restarts and a settings-driven replay path. Supersedes the original "AI Setup" step from the PRD-06 spec; Revv no longer prompts for an API key during onboarding.

→ [PRD-06 §3 Onboarding flow](./06-polish-ship.md#3-onboarding-flow)

---

## Multi-account auth

Two account kinds (`ConnectedAccount[]`, `LocalAccount[]`) reactive in `auth.svelte.ts`, with an `AccountPicker.svelte` switcher and account-scoped org filtering. Supports reviewers who work across multiple GitHub identities.

→ [PRD-06 §4 Multi-account support](./06-polish-ship.md#4-multi-account-support)

---

## GHE-default GitHub host

Revv defaults to `nocturlab.ghe.com`; public `github.com` is opt-in via onboarding step 2 or settings. All GitHub-touching code resolves the host at call time so the same code path works against either.

→ [PRD-06 §5 GHE / GitHub host configuration](./06-polish-ship.md#5-ghe--github-host-configuration)

---

## Opencode supervisor + dual agent paths

The chat and walkthrough agents both support two transports: Claude Agent SDK (in-process) and opencode (HTTP-MCP, subprocess). `OpencodeSupervisor` lazy-starts the subprocess only when needed and stops it when idle; `ChatMcpTokens` issues short-lived bearer tokens for the subprocess to authenticate back. Agent-path parity is a project invariant (CLAUDE.md "Agent Subsystem Invariants").

→ [PRD-02 §"Services" and §"MCP tool surface"](./02-chat-agent.md#services-appsserversrcservices)
→ [PRD-03 §"Dual agent transport"](./03-ai-walkthrough.md#dual-agent-transport)

---

## Chat-edit MCP surface

Post-completion mutation channel for walkthroughs. After a walkthrough's `status='complete'`, a separate set of MCP tools (`update_overview`, `add_block`, `update_block`, ratings/issues mutations, etc.) let the chat agent edit the walkthrough in place. Edits stamp `lastEditedAt` / `lastEditedBy`, never change `status` / `lastCompletedPhase`, and broadcast `walkthrough:edited` envelopes (not the generation SSE stream, which dies on `done`). Submitted issues are off-limits.

→ [PRD-03 §"Chat-edit tools"](./03-ai-walkthrough.md#mcp-tool-surface-appsserversrcaiproviderswalkthrough-tools)

---

## Proposed-changes strip

Real git commits accumulated on a per-PR `pr-{N}` worktree branch are the "proposal queue" — listed via `git log`, not stored in a mirror table. Reviewer can cherry-pick, discard, or push the whole stack via `git merge --force-with-lease`.

→ [PRD-05 §"Proposed-commits strip"](./05-chat-driven-changes.md#proposed-commits-strip-appsserversrcrouteschat-route-proposed-changests)

---

## AI merge-conflict resolution

When a push hits a merge conflict, the worktree is handed to the chat agent through `AiService.resolveMergeConflict` — a one-shot, non-persisted agent run with a dedicated system prompt. Stream frames pass through to the reviewer inline; on resolution the push finishes; on giveup the worktree is restored cleanly.

→ [PRD-05 §"AI-driven conflict resolution"](./05-chat-driven-changes.md#ai-driven-conflict-resolution)

---

## System tray with close-to-tray

macOS menu-bar icon with Open/Quit menu, close-to-tray window-hide behaviour, and `tauri_plugin_autostart` integration for login-triggered launches. Native notifications and badge count are still TODO.

→ [PRD-06 §8 System tray](./06-polish-ship.md#8-system-tray)

---

## Reviewer feedback on proposed commits

Comments left against a proposed commit's diff use the same `comment_threads` / `thread_messages` infrastructure as inline PR comments (via `ProposedCommentChip.svelte`). These don't sync to GitHub — they're feedback to the agent for the next chat turn.

→ [PRD-05 §"Reviewer feedback on proposed commits"](./05-chat-driven-changes.md#reviewer-feedback-on-proposed-commits)
