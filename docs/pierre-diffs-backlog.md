# @pierre/diffs Backlog

Opportunities to further leverage the `@pierre/diffs` ecosystem beyond what's already in use.
Revv already uses `FileDiff`, `File`, `parsePatchFiles`, SSR preloading, `@pierre/trees`,
worker pool, token hover, and line annotations. These are the remaining improvement paths.

## Summary

| Area | Open | Effort |
|---|---|---|
| Virtualization | 1 | M |
| Multi-file view | 1 | M |
| PatchDiff simplification | 1 | S |
| Token hover UI | 1 | M |
| Truncate for paths | 1 | S |
| **Total** | **5** | |

---

## Virtualization — `VirtualizedFileDiff`

**Priority:** P1 · **Effort:** M

**What:** Replace `FileDiff` with `VirtualizedFileDiff` (+ `Virtualizer`) in
`DiffViewerInner.svelte` and `FileViewerInner.svelte` so that only the visible
viewport of lines is rendered at any time.

**Why:** Large diffs (thousands of lines) currently render all DOM nodes at once,
causing jank on scroll and high memory usage. Virtualization renders only the
visible rows plus an overscan buffer.

**Where to change:**
- `apps/web/src/lib/components/review/DiffViewerInner.svelte` — swap
  `new FileDiff()` → `new VirtualizedFileDiff()`, wire up a `Virtualizer`
  instance, attach scroll container ref
- `apps/web/src/lib/components/review/FileViewerInner.svelte` — same pattern
- `apps/web/src/lib/components/review/ReviewLayout.svelte` — ensure the
  diff scroll container has a fixed height (required by virtualizer)

**Key API:**
```ts
import { VirtualizedFileDiff, Virtualizer } from '@pierre/diffs';
const virtualizer = new Virtualizer({ overscan: 5, estimatedRowHeight: 20 });
const diff = new VirtualizedFileDiff(options, workerManager, virtualizer);
diff.render({ oldFile, newFile, containerWrapper });
virtualizer.scrollToLine(n);
```

**Caveats:**
- Virtualizer requires a fixed-height container — verify `ReviewLayout` provides one
- `setSelectedLines` and `unsafeCSS` APIs should still work (same instance interface)
- SSR hydration path needs testing — virtualizer may not support hydrate; may need
  to fall back to `render()` for SSR'd content

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
- Virtualization is essential here (many files × many lines)
- Should this use `MultiFileDiff` from `@pierre/diffs/react` (requires React bridge)
  or build a vanilla wrapper around iterating `FileDiff` instances?

---

## Simplify with `PatchDiff` Component

**Priority:** P2 · **Effort:** S

**What:** Replace the manual git patch header construction + `parsePatchFiles()`
pattern in `DiffViewerInner.svelte` with Pierre's `PatchDiff` component, which
accepts a unified diff patch string directly.

**Why:** `DiffViewerInner.svelte:459-470` manually constructs a git patch header
string and calls `parsePatchFiles()` to get `FileDiffMetadata`. `PatchDiff` is
designed to accept a raw patch string and handle parsing internally, reducing
boilerplate and potential edge-case bugs in header construction.

**Where to change:**
- `apps/web/src/lib/components/review/DiffViewerInner.svelte` — replace
  `parsePatchFiles(fullPatch)` → `PatchDiff` component or `preloadPatchDiff`

**Key API:**
```ts
import { PatchDiff } from '@pierre/diffs/react';
// Or vanilla: preloadPatchDiff(patchString, options) → spread into PatchDiff
```

**Caveats:**
- `PatchDiff` is a React component; for Svelte we'd use the vanilla
  `preloadPatchDiff` SSR utility or the `ParsedPatch` type directly
- Need to verify that custom `renderHeaderPrefix` / `renderHeaderMetadata`
  callbacks still work with `PatchDiff`
- The view-mode pill toggle (unified/split) is currently rendered via
  `renderHeaderMetadata` — must still work

---

## Token Hover Tooltip UI

**Priority:** P2 · **Effort:** M

**What:** Build a floating tooltip that appears on token hover, powered by the
existing `onTokenEnter` / `onTokenLeave` callbacks already wired in
`DiffViewerInner.svelte:460-470`.

**Why:** The token hover plumbing already exists — `onTokenHover` bubbles
`TokenHoverInfo` up to `DiffViewer.svelte` — but no UI consumes it. A tooltip
could show:
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

## Path Truncation with `@pierre/truncate`

**Priority:** P3 · **Effort:** S

**What:** Use `@pierre/truncate` components (`MiddleTruncate`, `Fruncate`) for
long file paths in the sidebar file tree and diff viewer headers.

**Why:** Deeply nested file paths currently overflow or wrap awkwardly in the
sidebar and header. Pierre's `@pierre/truncate` provides intelligent truncation
strategies (preserve extension, preserve leaf path, fade variant) that are
cleaner than CSS `text-overflow: ellipsis`.

**Where to change:**
- `apps/web/src/lib/components/sidebar/PierreFileTree.svelte` — use `Fruncate`
  for file path labels in the tree
- `apps/web/src/lib/components/review/DiffViewerInner.svelte` — use
  `MiddleTruncate` for the file path in the diff header
- `apps/web/src/lib/components/review/ReviewLayout.svelte` — truncate the
  active file name in the top bar

**Key API:**
```tsx
import { MiddleTruncate, Fruncate } from '@pierre/truncate/react';
// For Svelte: use the underlying OverflowText class from '@pierre/truncate'
// or wrap the React components
```

**Caveats:**
- `@pierre/truncate` is React-only; for Svelte we'd need to use the vanilla
  `OverflowText` class or implement equivalent CSS truncation
- May not be worth adding a new dependency if CSS `text-overflow` suffices
- Check if `@pierre/truncate` is already in `package.json` (it is not)
