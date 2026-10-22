# @pierre/diffs Backlog

Opportunities to further leverage the `@pierre/diffs` ecosystem beyond what's already in use.
Revv already uses `FileDiff`, `VirtualizedFileDiff`, `File`/`VirtualizedFile`, `Virtualizer`,
`parsePatchFiles`, SSR preloading, `@pierre/trees`, worker pool, token hover, and line
annotations. These are the remaining improvement paths.

## Summary

| Area | Open | Effort |
|---|---|---|
| Multi-file view | 1 | M |
| Token hover UI | 1 | M |
| **Total** | **2** | |

---

## Multi-File Diff View

**Priority:** P2 · **Effort:** M

**What:** Add a "View All Changes" mode that renders the entire PR diff as a
single scrollable document using `MultiFileDiff` instead of one-file-at-a-time.

**Why:** Reviewers often want to scan all changes in sequence without clicking
through files. GitHub's "Files changed" tab works this way.

**Where to change:**
- New component: `apps/web/src/lib/components/review/MultiFileDiffViewer.svelte`
- `apps/web/src/lib/components/review/ReviewLayout.svelte` — add toggle between
  single-file and multi-file modes
- `apps/web/src/lib/stores/review.svelte.ts` — add `multiFileMode: boolean` state

**Key API:**
```tsx
import { MultiFileDiff } from '@pierre/diffs/react';
// For Svelte, use vanilla MultiFileDiff class or wrap React component
```

**Design decisions:**
- File tree sidebar should remain visible for navigation
- Annotations/threads need to work across all files simultaneously
- Virtualization is essential here (many files × many lines) — reuse the
  `createPierreVirtualizer` helper already wired into `DiffViewerInner.svelte`
- Should this use `MultiFileDiff` from `@pierre/diffs/react` (requires React bridge)
  or build a vanilla wrapper around iterating `FileDiff` instances?

---

## Token Hover Tooltip UI

**Priority:** P2 · **Effort:** M

**What:** Build a floating tooltip that appears on token hover, powered by the
existing `onTokenEnter` / `onTokenLeave` callbacks already wired in
`DiffViewerInner.svelte` and `FileViewerInner.svelte`.

**Why:** The token hover plumbing already exists — `onTokenHover` bubbles
`TokenHoverInfo` up to `DiffViewer.svelte` / `FileViewer.svelte` — but no UI
consumes it (no parent passes a handler). A tooltip could show:
- Syntax token type (keyword, string, comment, etc.)
- AI-generated context (type inference, definition lookup)
- Quick actions (copy token, search in codebase)

**Where to change:**
- `apps/web/src/lib/components/review/DiffViewer.svelte` — add floating
  tooltip component bound to `onTokenHover` callback
- New component: `apps/web/src/lib/components/review/TokenTooltip.svelte`

**Key data already available:**
```ts
interface TokenHoverInfo {
  tokenText: string;
  lineNumber: number;
  side: string;
  element: HTMLElement;  // for positioning
}
```

**Design decisions:**
- Position tooltip relative to `element.getBoundingClientRect()`
- Debounce show/hide to avoid flicker on fast mouse movement
- Should token type info come from the DOM element's Shiki classes
  (e.g., `token.keyword`) or from a separate analysis step?

---

## Resolved / withdrawn

Closed by the "Improve Pierre diff rendering" work (commit `f81d07d`) and the
warm-palette wiring (`#108`):

- **Virtualization (`VirtualizedFileDiff`)** — *Shipped.* Both
  `DiffViewerInner.svelte` and `FileViewerInner.svelte` now construct a
  `VirtualizedFileDiff` / `VirtualizedFile` via the shared
  `createPierreVirtualizer` adapter (`pierre-diff-adapter.ts`), falling back to
  the non-virtualized class only when there's no scroll root. The sidebar file
  tree virtualizes natively through `@pierre/trees` `FileTree`
  (`data-file-tree-virtualized-scroll`).
- **Simplify with `PatchDiff`** — *Withdrawn.* The manual `buildGitPatchHeader`
  + `parsePatchFiles` path is now a deliberate choice: it preserves GitHub's
  exact additions/deletions counts (so header stats match the file tree without
  overrides) and supports the SSR-hydrate path plus the custom
  `renderHeaderPrefix` / `renderHeaderMetadata` header slots and the
  unified/split view-mode pill — none of which the React-only `PatchDiff`
  component accommodates.
- **Path truncation with `@pierre/truncate`** — *Withdrawn.* `PierreFileTree.svelte`
  deliberately *disables* Pierre's built-in `MiddleTruncate` in favor of showing
  the full path with horizontal scroll (and a synced per-row min-width that keeps
  the sticky LOC badges aligned). No new dependency needed.
