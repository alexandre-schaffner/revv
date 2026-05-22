# Layout Audit Backlog

This document tracks the open items from the layout-code audit (May 2026). Items are grouped by priority and include file paths, line numbers, and the specific concern. Checked items were completed in that session; unchecked items are still outstanding.

---

## Completed

- [x] **Extract WalkthroughActionBar from AppShell.svelte** — Reduced AppShell from 935 → 530 lines (–43%). Moved walkthrough-specific floating-bar markup (streaming/resumable/error/complete states, scroll-to-top/bottom/rating pills) into `src/lib/components/layout/WalkthroughActionBar.svelte`.

- [x] **Extract RequestChangesActionBar from AppShell.svelte** — Moved the RC action bar (generate-changes, submit-review, approve, owner merge/close actions, merge split-button) into `src/lib/components/layout/RequestChangesActionBar.svelte`. Also moved the merge-pill CSS from AppShell's `<style>` block into the new component.

- [x] **Replace inline `style` tab visibility in review/[prId]/+page.svelte** — Three `style={activeTab === 'x' ? 'display: ...' : ''}` expressions replaced with scoped CSS classes `.review-content--hidden`, `.tab-wrapper`, `.tab-wrapper--hidden`.

- [x] **Consolidate daily/weekly recap pages** — Shared wrapper `RecapPeriodPage.svelte` created; `/recaps/daily` and `/recaps/weekly` are now thin shells that pass `period="daily"` / `period="weekly"`.

- [x] **Create shared SelectTrigger.svelte primitive** — `AgentSelector`, `ModelSelector`, and `ThinkingEffortSelector` now import and render `<SelectTrigger>` instead of duplicating the identical trigger button markup.

- [x] **Create `getMainAreaBounds()` derived store** — Added to `src/lib/stores/sidebar.svelte.ts`. Eliminates duplicated grid-math in `recaps/+page.svelte` (and any future fixed-position chrome).

- [x] **Replace hardcoded values in `.prose-table`** — `margin: 0 0 12px` → `var(--spacing-inset)`, `border-radius: 6px` → `var(--radius-card)`, `padding: 8px 12px` → `var(--spacing-island) var(--spacing-inset)`.

- [x] **Simplify home page wrapper nesting** — Collapsed two nested flex/text-center divs into one `flex flex-col items-center justify-center text-center` container.

- [x] **Remove redundant `data-tauri-drag-region` from TopBar children** — The attribute only needs to exist on the parent `.title-block`; removed from child spans.

- [x] **Decompose RightPanel.svelte (2,057 → 449 lines, –78%)** — Extracted 5 sub-components: `ChatTimeline.svelte` (515 lines), `ProposedChangesDock.svelte` (447 lines), `PushDialogs.svelte` (501 lines), `ChatInputArea.svelte` (94 lines), `BlockedStrip.svelte` (186 lines). Each component imports store getters directly (following the `WalkthroughActionBar` pattern) instead of prop-threading. Moved all component-specific CSS into the extracted files. Also migrated `:global(.motion-essential-spin)` keyframe from RightPanel's `<style>` block to `app.css` (used by 8 other components).

- [x] **Extract all 9 provider icon components from ModelSelector** — Created `GitHubCopilotIcon`, `GoogleIcon`, `MistralIcon`, `GroqIcon`, `BedrockIcon`, `AzureIcon` (joining existing `AnthropicIcon`, `OpenAIIcon`, `OpenCodeIcon`). Added `ProviderIcon.svelte` wrapper with component map. `ModelSelector` went from 295 → 182 lines (–38%), removing 100+ lines of raw SVG path data and the `getProviderIcon()` function.

- [x] **Refactor ReviewLayout.svelte keyboard handler** — Replaced 206-line sequential if-ladder with `PendingGState` class (encapsulated gg-chord state machine) and two-level command map (`PANEL_KEY_MAP` → `DIFF_VISUAL_KEYS` / `DIFF_LINE_KEYS` / `DIFF_SCROLL_KEYS`). `dispatchKey()` handles panel routing and gg-chord pre-dispatch. ReviewLayout went from 497 → 458 lines (–8%).

---

## Outstanding

_No outstanding items._

---

## Summary Table

| # | Concern | Priority | Status | Effort |
|---|---------|----------|--------|--------|
| 1 | AppShell → WalkthroughActionBar + RequestChangesActionBar | P0 | ✅ Done | Medium |
| 2 | RightPanel → ChatTimeline + ProposedChangesDock + PushDialogs + ChatInputArea + BlockedStrip | P0 | ✅ Done | Large |
| 3 | Inline style tab visibility → CSS classes | P0 | ✅ Done | Small |
| 4 | ModelSelector SVGs → icon components | P1 | ✅ Done (9/9) | Medium |
| 5 | Duplicate daily/weekly recap pages → shared | P1 | ✅ Done | Small |
| 6 | Shared SelectTrigger primitive | P1 | ✅ Done | Small |
| 7 | ReviewLayout keyboard → command-map | P2 | ✅ Done | Medium |
| 8 | Duplicated layout math → getMainAreaBounds() | P2 | ✅ Done | Small |
| 9 | prose-table hardcoded values → tokens | P2 | ✅ Done | Tiny |
| 10 | Home page wrapper nesting | P3 | ✅ Done | Tiny |
| 11 | TopBar redundant drag-region attributes | P3 | ✅ Done | Tiny |

---

_All items resolved._
