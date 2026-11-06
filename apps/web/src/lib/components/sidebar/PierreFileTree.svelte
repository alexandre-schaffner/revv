<script lang="ts">
import {
  FileTree,
  type FileTreeDirectoryHandle,
  type FileTreeItemHandle,
  type FileTreeVisibleRow,
  type GitStatusEntry,
} from "@pierre/trees";
import { onDestroy, untrack } from "svelte";

interface Props {
  /** Every file path in the repo at the PR's head SHA. */
  paths: string[];
  /** PR-changed files only. Keys must be a subset of `paths`. */
  statusByPath: Map<string, GitStatusEntry["status"]>;
  /** Line-change stats for the row badge; only changed files have entries. */
  statsMap?: Map<string, { additions: number; deletions: number }>;
  /** Currently focused file in the diff viewer (for highlighting). */
  activePath: string | null;
  /** User clicked a *file* (directories are handled internally by the tree). */
  onSelect: (path: string) => void;
  /** Focus the tree when the files view opens. */
  shouldFocus?: boolean;
  /** Refocus the tree each time this goes false → true (the sidebar regains
   *  control from a diff mode). `shouldFocus` stays true throughout diff
   *  navigation, so it can't. */
  panelActive?: boolean;
  /** `'open'` expands every directory (Changed-only mode, a small set);
   *  `'closed'` is the default, for Whole-repo browsing. */
  initialExpansion?: "open" | "closed";
  /** Filter applied through the library's search session (`tree.setSearch`);
   *  null or empty clears it. The input lives in our DOM
   *  (SidebarFilesSearch.svelte), not the library's in-shadow search row.
   *  The library's default 'hide-non-matches' mode is the one we want. */
  searchQuery?: string | null;
}

let {
  paths,
  statusByPath,
  statsMap,
  activePath,
  onSelect,
  shouldFocus = false,
  panelActive = false,
  initialExpansion = "closed",
  searchQuery = null,
}: Props = $props();

// Phantom rows appended to every path set we hand the library.
// `FileTreeView.update()` clamps `scrollTop` to
// `(visibleRows * itemHeight) - viewportHeight` on every tick, so a
// `padding-block-end` on the scroll container is snapped straight back.
// Padding the row count instead gives the real last file room to scroll
// clear of the bottom `.sidebar-fade`: 3 × 24px rows = 72px, ~24px clear of
// the 48px fade. `~~~` sorts after every printable ASCII path.
const PHANTOM_PATH_PREFIX = "~~~revv-tree-pad-";
const PHANTOM_COUNT = 3;
const PHANTOM_PATHS: readonly string[] = Array.from(
  { length: PHANTOM_COUNT },
  (_, i) => `${PHANTOM_PATH_PREFIX}${i}`,
);

// `@pierre/trees` throws `Duplicate path: "…"` on a repeated path, from inside
// the `$effect` below, which aborts the whole Svelte flush: every effect queued
// after this component (e.g. the walkthrough's `use:mountCodeBlock`) silently
// never runs. The server dedupes GitHub's file list, but a tree crash is too
// destructive to leave undefended here.
function withPhantomPaths(real: readonly string[]): string[] {
  return [...new Set(real), ...PHANTOM_PATHS];
}

function isPhantomPath(path: string): boolean {
  return path.startsWith(PHANTOM_PATH_PREFIX);
}

// Plain (non-reactive) so a stats update repaints through
// `renderRowDecoration` instead of rebuilding the tree.
let statsRef: Map<string, { additions: number; deletions: number }> = new Map();

// `renderRowDecoration` returns a single text node, with no per-character
// colour. For a two-tone badge (red `-N`, green `+N`) it returns an empty span
// and per-path rules in the shadow root fill `::before` (deletions) and
// `::after` (additions); those survive the virtualizer's re-renders.
function syncStatsStyle(): void {
  const container = tree?.getFileTreeContainer();
  const shadowRoot = container?.shadowRoot;
  if (!shadowRoot) return;

  const STYLE_ID = "revv-stat-colors";
  let el = shadowRoot.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    shadowRoot.appendChild(el);
  }

  const lines: string[] = [];
  for (const [path, { additions, deletions }] of statsRef) {
    const sel = `button[data-item-path="${CSS.escape(path)}"] > [data-item-section='decoration']`;
    // Emit both pseudos even for a zero count: an empty `content` still
    // reserves the slot's `min-width`, so the column's leading edge doesn't
    // zigzag row to row.
    const delContent = deletions > 0 ? `-${deletions}` : "";
    const addContent = additions > 0 ? `+${additions}` : "";
    lines.push(
      `${sel}::before { content: '${delContent}'; color: var(--trees-git-deleted-color); margin-right: 4px; }`,
    );
    lines.push(`${sel}::after { content: '${addContent}'; color: var(--trees-git-added-color); }`);
  }
  el.textContent = lines.join("\n");
}

$effect(() => {
  statsRef = statsMap ?? new Map();
  untrack(() => {
    if (tree) {
      syncStatsStyle();
      tree.setGitStatus(buildGitStatus(statusByPath));
    }
  });
});

let host: HTMLDivElement;
let tree: FileTree | null = null;
let clickHandler: (() => void) | null = null;
let keyHandler: ((event: KeyboardEvent) => void) | null = null;

// `resetPaths` takes a list of expanded paths, not the `'open'` shorthand, so
// an `initialExpansion` change rebuilds the tree instead.
let liveExpansion: "open" | "closed" | null = null;

function buildGitStatus(map: Map<string, GitStatusEntry["status"]>): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (const [path, status] of map) {
    entries.push({ path, status });
  }
  return entries;
}

// Rebuild only when `paths` changes: the library owns selection and expansion,
// so clicks inside the tree must not rebuild it.
$effect(() => {
  const currentPaths = paths;
  const expansion = initialExpansion;

  if (!host) return;

  untrack(() => {
    const initialSelected = activePath ? [activePath] : [];
    const initialGitStatus = buildGitStatus(statusByPath);

    if (tree !== null && liveExpansion !== expansion) {
      tree.cleanUp();
      tree = null;
    }

    if (tree === null) {
      const initialQuery = searchQuery && searchQuery.length > 0 ? searchQuery : null;

      let lastEmittedPath: string | null = activePath;

      tree = new FileTree({
        paths: withPhantomPaths(currentPaths),
        initialExpansion: expansion,
        initialSelectedPaths: initialSelected,
        initialSearchQuery: initialQuery,
        gitStatus: initialGitStatus,
        // The library tints changed *file* rows, but a directory with a changed
        // descendant only colours its git-lane indicator, so a change buried
        // deep in the tree is easy to miss. `button[data-type='item']`
        // out-specifies the base layer's `[data-type='item']` in the shadow root.
        unsafeCSS: `
						button[data-type='item'][data-item-contains-git-change='true'] > [data-item-section='content'] {
							color: var(--trees-git-modified-color);
						}
						button[data-type='item'] > [data-item-section='decoration']::before,
						button[data-type='item'] > [data-item-section='decoration']::after {
							font-family: var(--font-mono, ui-monospace, monospace);
							font-size: 10px;
							letter-spacing: -0.02em;
							font-variant-numeric: tabular-nums;
							/* Fixed-width slots (\`-N\` leading, \`+N\` trailing) keep the
							 * column's leading edge from zigzagging row to row. */
							display: inline-block;
							text-align: end;
						}
						button[data-type='item'] > [data-item-section='decoration']::before {
							min-width: 2.25em;
						}
						button[data-type='item'] > [data-item-section='decoration']::after {
							min-width: 2.5em;
						}
						/* The library reserves \`scrollbar-gutter: stable\` and subtracts it
						 * from the right padding; with macOS overlay scrollbars that leaves a
						 * ~6px dead zone the PR list doesn't have. Symmetric 2px padding gives
						 * each row 2 + 2 (item margin) + 8 (item padding) = 12px, the list's
						 * \`px-3\`. */
						[data-file-tree-virtualized-scroll='true'] {
							scrollbar-gutter: auto;
							padding-inline: 2px;
							overscroll-behavior: contain;
						}
						/* Phantom rows stay laid out so the virtualizer reserves their
						 * \`itemHeight\`, but invisible and inert. */
						button[data-type='item'][data-item-path^='${PHANTOM_PATH_PREFIX}'] {
							visibility: hidden;
							pointer-events: none;
						}
						/* Pierre middle-truncates an overflowing name (keeping the extension);
						 * \`min-width: 0\` lets the content cell shrink so that engages. */
						button[data-type='item'] > [data-item-section='content'] {
							min-width: 0;
						}
						/* The name truncates before this gutter, so the LOC count is always
						 * fully visible. 58px ≈ 6px pad + 2.25em + 4px gap + 2.5em at 10px
						 * mono. */
						button[data-type='item'] > [data-item-section='decoration'] {
							flex: 0 0 auto;
							margin-inline-start: auto;
							padding-inline-start: 6px;
							min-width: 58px;
						}
					`,
        // The cell has to exist to host the `::before`/`::after` stats that
        // `syncStatsStyle()` fills in.
        renderRowDecoration: (ctx) => {
          if (ctx.item.kind !== "file") return null;
          const stats = statsRef.get(ctx.item.path);
          if (!stats || (stats.additions === 0 && stats.deletions === 0)) {
            return null;
          }
          return { text: "" };
        },
        onSelectionChange: (selected) => {
          // Directory vs file filtering happens in SidebarFilesView: calling
          // `getItem` here runs inside the library's row-click handler, between
          // `selectOnlyPath` and the directory toggle, and the toggle then never
          // reaches the store. Keyboard nav can still focus phantom rows.
          const first = selected[0];
          if (typeof first === "string" && !isPhantomPath(first)) {
            lastEmittedPath = first;
            onSelect(first);
          }
        },
      });
      tree.render({ containerWrapper: host });
      syncStatsStyle();
      liveExpansion = expansion;

      // `onSelectionChange` only fires on a change, so a click on the
      // already-selected file needs this to re-fire `onSelect`. It runs after a
      // microtask so the library's own handler settles first.
      if (clickHandler) host.removeEventListener("click", clickHandler);
      clickHandler = () => {
        Promise.resolve().then(() => {
          const selected = tree?.getSelectedPaths() ?? [];
          const path = selected[0];
          if (typeof path === "string" && !isPhantomPath(path) && path === lastEmittedPath) {
            onSelect(path);
          }
        });
      };
      host.addEventListener("click", clickHandler);

      // Keep arrow / PageDown / End from walking focus into the phantom rows.
      // The library handles keys on its tree root inside the shadow root, so a
      // capture-phase listener on `host` runs first and can cancel it.
      if (keyHandler) host.removeEventListener("keydown", keyHandler, true);
      keyHandler = (event: KeyboardEvent) => {
        const key = event.key;
        const isEnd = key === "End" || (key === "ArrowDown" && (event.metaKey || event.ctrlKey));
        const isStep = key === "ArrowDown" || key === "PageDown";
        if (isEnd) {
          const last = lastRealPath();
          if (last === null) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          tree?.focusPath(last);
          return;
        }
        if (isStep && nextIsPhantom()) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      };
      host.addEventListener("keydown", keyHandler, true);
    } else {
      // `resetPaths` keeps scroll and expansion for unchanged subtrees, which
      // matters when a new commit is pulled.
      tree.resetPaths(withPhantomPaths(currentPaths));
      tree.setGitStatus(initialGitStatus);
      syncStatsStyle();
    }
  });
});

$effect(() => {
  const map = statusByPath;
  if (!tree) return;
  untrack(() => tree?.setGitStatus(buildGitStatus(map)));
});

// Separate from the rebuild effect: `setSearch` is a cheap projection update.
// `null` is Pierre's documented "clear" value.
$effect(() => {
  const query = searchQuery;
  if (!tree) return;
  untrack(() => {
    tree?.setSearch(query && query.length > 0 ? query : null);
  });
});

// The bail matters: the library's row click does `selectOnlyPath` then
// `item.toggle()`, and a `select()` from here in between re-emits
// `onSelectionChange`, whose Preact render can swallow the toggle.
$effect(() => {
  const path = activePath;
  if (!tree) return;
  untrack(() => {
    if (path != null) selectOnly(path);
  });
});

/**
 * Make `path` the only selected row. `item.select()` *appends* to the
 * selection, and `onSelectionChange` consumers read `selected[0]` — so a stale
 * earlier selection would win. Returns false when it already was the only one.
 */
function selectOnly(path: string): boolean {
  const current = tree?.getSelectedPaths() ?? [];
  if (current.length === 1 && current[0] === path) return false;
  for (const p of current) {
    if (p !== path) tree?.getItem(p)?.deselect();
  }
  tree?.getItem(path)?.select();
  return true;
}

function visibleRows(): readonly FileTreeVisibleRow[] {
  const count = tree?.getVisibleCount() ?? 0;
  return count > 0 && tree ? tree.getVisibleRows(0, count - 1) : [];
}

function firstRealPath(kind?: "file"): string | null {
  const row = visibleRows().find(
    (r) => !isPhantomPath(r.path) && (kind === undefined || r.kind === kind),
  );
  return row?.path ?? null;
}

function lastRealPath(): string | null {
  const rows = visibleRows();
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row && !isPhantomPath(row.path)) return row.path;
  }
  return null;
}

function nextIsPhantom(): boolean {
  if (!tree) return false;
  const next = tree.getVisibleRows(tree.getFocusedIndex() + 1, tree.getFocusedIndex() + 1)[0];
  return next !== undefined && isPhantomPath(next.path);
}

function isDirectory(item: FileTreeItemHandle): item is FileTreeDirectoryHandle {
  return item.isDirectory();
}

function hasDomFocus(): boolean {
  return tree?.getFileTreeContainer()?.shadowRoot?.activeElement != null;
}

/**
 * Put DOM focus on `path`'s row. The library moves DOM focus along with its
 * focus cursor on its next (async, Preact) render — but only while focus is
 * already inside the tree, and only when the cursor actually moves. So: a row
 * that is rendered gets focused directly (its focus handler moves the cursor);
 * otherwise focus the tree's root and move the cursor, and the library brings
 * the row into view and focuses it when it renders.
 */
function focusRow(path: string): void {
  const shadowRoot = tree?.getFileTreeContainer()?.shadowRoot;
  if (!tree || !shadowRoot) return;
  const row = shadowRoot.querySelector<HTMLElement>(
    `button[data-type="item"][data-item-path="${CSS.escape(path)}"]:not([data-file-tree-sticky-row="true"])`,
  );
  if (row) {
    row.focus();
    return;
  }
  shadowRoot.querySelector<HTMLElement>('[role="tree"]')?.focus({ preventScroll: true });
  tree.focusPath(path);
}

function claimFocus(): void {
  if (hasDomFocus()) return;
  const path = tree?.getFocusedPath() ?? firstRealPath();
  if (path) focusRow(path);
}

function focusActive(): void {
  const path = activePath ?? firstRealPath();
  if (tree && path) focusRow(path);
  else host?.focus();
}

$effect(() => {
  if (!shouldFocus || !host) return;
  untrack(focusActive);
});

$effect(() => {
  if (!panelActive || !host) return;
  untrack(focusActive);
});

export function moveFocus(direction: 1 | -1): void {
  if (!tree) return;
  claimFocus();
  if (direction === 1) {
    if (!nextIsPhantom()) tree.focusNextItem();
  } else {
    tree.focusPreviousItem();
  }
}

/** Directory: expand it, or step into it when already open. File: open it. */
export function openFocused(): void {
  if (!tree) return;
  claimFocus();
  const item = tree.getFocusedItem();
  if (!item) return;
  if (isDirectory(item)) {
    if (item.isExpanded()) moveFocus(1);
    else item.expand();
    return;
  }
  const path = item.getPath();
  if (isPhantomPath(path)) return;
  // A re-open of the selected file fires no selection change.
  if (!selectOnly(path)) onSelect(path);
}

/**
 * Collapse an open directory, else move to the parent row. False when there
 * is nowhere to go: no row has focus, or it's a closed root-level row.
 */
export function collapseOrParent(): boolean {
  if (!tree || !hasDomFocus()) return false;
  const item = tree.getFocusedItem();
  if (item && isDirectory(item) && item.isExpanded()) {
    item.collapse();
    return true;
  }
  const index = tree.getFocusedIndex();
  const row = tree.getVisibleRows(index, index)[0];
  if (!row || row.ancestorPaths.length === 0) return false;
  tree.focusParentItem();
  return true;
}

/**
 * Apply `query` now and focus the first matching *file* — search keeps
 * matching files' ancestor directories visible, and landing on one of those
 * would point at an unrelated folder. Focus only; opening is a second Enter.
 */
export function focusFirstMatch(query: string): void {
  if (!tree) return;
  tree.setSearch(query.length > 0 ? query : null);
  const path = firstRealPath("file");
  if (path) focusRow(path);
}

onDestroy(() => {
  if (clickHandler) {
    host?.removeEventListener("click", clickHandler);
    clickHandler = null;
  }
  if (keyHandler) {
    host?.removeEventListener("keydown", keyHandler, true);
    keyHandler = null;
  }
  tree?.cleanUp();
  tree = null;
});
</script>

<div bind:this={host} class="pierre-tree-host" tabindex="-1"></div>

<style>
	.pierre-tree-host {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		contain: layout paint;
		/* The tree's CSS resolves `light-dark()` against the host's `color-scheme`
		   (this rule beats its own `:host { color-scheme: light dark }`), and
		   <html> carries the theme's. The overrides below only cover surfaces:
		   file-icon, git-status and focus-ring colours go through `light-dark()`,
		   and the icons must match the composer's mention pills, which resolve the
		   same sprite against <html> (lib/utils/file-icon.ts). */
		color-scheme: inherit;

		/* Map our design tokens onto the @pierre/trees CSS variables. The
		   library's fallback chain is `--trees-*-override` (us) →
		   `--trees-theme-*` → built-in defaults, so any override here wins. */
		--trees-bg-override: var(--color-bg-secondary);
		--trees-fg-override: var(--color-text-secondary);
		--trees-fg-muted-override: var(--color-text-muted);
		--trees-border-color-override: var(--color-border);
		--trees-selected-bg-override: var(--color-tree-active-bg);
		--trees-selected-fg-override: var(--color-tree-active-text);
		--trees-accent-override: var(--color-accent);
		--trees-bg-muted-override: var(--color-bg-tertiary);
		/* Match the PR list's px-3 (12px) left/right padding.
		   Effective row indent = max(inline - item-margin, 0) + item-margin + item-padding-x
		                        = max(4px - 2px, 0) + 2px + 8px = 12px */
		--trees-padding-inline-override: 4px;
		/* Tighter than the library's 8px default, and constant at any panel width. */
		--trees-level-gap-override: 2px;
	}

	.pierre-tree-host:focus {
		outline: none;
	}
</style>
