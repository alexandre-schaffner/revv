<script lang="ts">
import { FileTree, type GitStatusEntry } from "@pierre/trees";
import { onDestroy, untrack } from "svelte";

interface Props {
  /** Every file path in the repo at the PR's head SHA. */
  paths: string[];
  /** PR-changed files only. Keys must be a subset of `paths`. */
  statusByPath: Map<string, GitStatusEntry["status"]>;
  /** Line-change stats for the right-side badge. Keyed on file path;
   *  only changed files have entries. Undefined entries render nothing. */
  statsMap?: Map<string, { additions: number; deletions: number }>;
  /** Currently focused file in the diff viewer (for highlighting). */
  activePath: string | null;
  /** User clicked a *file* (directories are handled internally by the tree). */
  onSelect: (path: string) => void;
  /** When true, the wrapper focuses the tree's root on mount so arrow keys
   *  drive navigation. Used when switching into files view. */
  shouldFocus?: boolean;
  /** Goes false → true every time the sidebar panel regains control after
   *  a diff mode (Escape / Space). Triggers focus restoration so the user
   *  doesn't have to re-click the tree after returning from the diff pane.
   *  Complements `shouldFocus`, which only fires on the PR-list → files
   *  view-switch and stays true throughout diff navigation. */
  panelActive?: boolean;
  /** Initial expansion state for new trees. `'open'` expands every
   *  directory (used in Changed-only mode where the path set is
   *  small and the user wants to see all files immediately).
   *  `'closed'` is the default and matches Whole-repo browsing. */
  initialExpansion?: "open" | "closed";
  /** Active filter applied to the tree via the library's built-in
   *  search session (`tree.setSearch`). `null` or empty string clears
   *  the filter. We drive search programmatically rather than enabling
   *  the library's own in-shadow search row, so the input UI lives in
   *  our DOM (see SidebarFilesSearch.svelte) and matches the rest of
   *  the sidebar's styling. The default search mode
   *  ('hide-non-matches') is exactly what we want — verified at
   *  FileTreeController.js:260 — so we don't pass `fileTreeSearchMode`. */
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

// Phantom rows appended to every path set we hand to the library.
// `FileTreeView.update()` hard-clamps `scrollEl.scrollTop` to
// `(visibleRows * itemHeight) - viewportHeight` on every tick — any
// `padding-block-end` we add to the scroll container is snapped back
// instantly. We instead pad the *row count*: the library treats these
// as ordinary rows for clamp math (so the user can scroll far enough
// that the real last file sits above the bottom `.sidebar-fade`
// overlay), but a CSS rule down in `unsafeCSS` makes them visually
// inert. Three rows × the default 24px item height = 72px of trailing
// scroll room, which lands the real last row ~24px clear of the 48px
// fade. The `~~~` prefix sorts after every printable ASCII path so
// sentinels never wedge in between real files.
const PHANTOM_PATH_PREFIX = "~~~revv-tree-pad-";
const PHANTOM_COUNT = 3;
const PHANTOM_PATHS: readonly string[] = Array.from(
  { length: PHANTOM_COUNT },
  (_, i) => `${PHANTOM_PATH_PREFIX}${i}`,
);

function withPhantomPaths(real: readonly string[]): string[] {
  return [...real, ...PHANTOM_PATHS];
}

function isPhantomPath(path: string): boolean {
  return path.startsWith(PHANTOM_PATH_PREFIX);
}

// The library renders flow rows inside `[data-file-tree-virtualized-sticky]`
// in index order, with optional parked rows appended afterwards. To find the
// next row that would receive focus after `from`, walk forward siblings and
// skip anything that isn't a non-parked tree row.
function nextFlowRow(from: HTMLElement): HTMLElement | null {
  let sib = from.nextElementSibling;
  while (sib != null) {
    if (
      sib instanceof HTMLElement &&
      sib.matches('button[data-type="item"]') &&
      sib.dataset.itemParked !== "true"
    ) {
      return sib;
    }
    sib = sib.nextElementSibling;
  }
  return null;
}

// Last real (non-phantom) flow row currently rendered in the shadow root.
// Used to bounce End / Cmd-ArrowDown back from phantom territory. Walks
// rows in reverse so we can stop at the first real one — phantoms always
// sort last via the `~~~` prefix, so this is a constant-time scan over the
// 3 phantom rows.
function findLastRealRowEl(sr: ShadowRoot): HTMLElement | null {
  const rows = sr.querySelectorAll<HTMLElement>('button[data-type="item"]');
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (
      row != null &&
      row.dataset.itemParked !== "true" &&
      !isPhantomPath(row.dataset.itemPath ?? "")
    ) {
      return row;
    }
  }
  return null;
}

// Mutable ref so the `renderRowDecoration` closure always reads the
// current stats without triggering a full tree rebuild on every
// `reviewFiles` update. Stats and paths change together on PR switch
// (the rebuild happens via the paths $effect anyway), so the ref is
// always up to date when the library calls `renderRowDecoration`.
let statsRef: Map<string, { additions: number; deletions: number }> = new Map();

// ── Per-path colour injection ──────────────────────────────────────────
// `renderRowDecoration` returns a single text node — the public API has
// no per-character colour control. To get genuine two-tone (red `-N`,
// green `+N`) we make `renderRowDecoration` return an empty span and
// then inject per-path CSS rules that fill the decoration cell with
// `::before` (deletions, red) and `::after` (additions, green) pseudo-
// elements. CSS selectors in a shadow root apply to every virtual-
// render pass so scroll events don't invalidate the rules.
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
    // CSS.escape handles paths with special characters (dots, slashes).
    const sel = `button[data-item-path="${CSS.escape(path)}"] > [data-item-section='decoration']`;
    // Deletions go in `::before` (renders left of the empty span);
    // additions go in `::after` (renders right). We always emit BOTH
    // rules even when one of the counts is zero — passing `content: ''`
    // generates the pseudo with an empty string, which still reserves
    // its `min-width` flex slot from the static rule. Without this,
    // `::before` (or `::after`) wouldn't render at all and the column's
    // leading edge would zigzag between rows depending on whether
    // each one has deletions, additions, or both. `margin-right` only
    // matters when the deletion text is non-empty; we keep it
    // unconditionally so the gap geometry stays uniform across rows.
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
      // Sync colour rules first, then poke the tree to repaint rows.
      syncStatsStyle();
      tree.setGitStatus(buildGitStatus(statusByPath));
    }
  });
});

let host: HTMLDivElement;
let tree: FileTree | null = null;
// Cleanup handle for the re-click listener — replaced on each tree build.
let clickHandler: (() => void) | null = null;
// Cleanup handle for the capture-phase keydown gate — replaced on each tree build.
let keyHandler: ((event: KeyboardEvent) => void) | null = null;

// Remembers what `initialExpansion` the live tree was constructed with.
// When the prop flips (e.g. user toggles file-tree scope), we tear the
// tree down and rebuild instead of taking the cheap `resetPaths` path —
// `resetPaths` only accepts a path-list of expanded items, not the
// `'open'` shorthand, so a fresh `new FileTree({ initialExpansion: 'open' })`
// is the simplest way to expand-everything for the new path set.
let liveExpansion: "open" | "closed" | null = null;

function buildGitStatus(map: Map<string, GitStatusEntry["status"]>): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (const [path, status] of map) {
    entries.push({ path, status });
  }
  return entries;
}

// Build once on first paint, and only when `paths` reference changes after
// that. Tracking `paths` alone (instead of also `statusByPath` /
// `activePath`) means clicks inside the tree don't kick off rebuilds — the
// library handles its own selection/expansion state internally and we only
// fire `onSelect` for file rows.
$effect(() => {
  const currentPaths = paths;
  // Track the prop so a scope-toggle re-runs this effect even if the
  // path list itself happens to share a reference (it shouldn't, but
  // belt-and-suspenders against `$derived.by` returning the same array).
  const expansion = initialExpansion;

  if (!host) return;

  untrack(() => {
    const initialSelected = activePath ? [activePath] : [];
    const initialGitStatus = buildGitStatus(statusByPath);

    // If the requested expansion changed, throw away the existing
    // instance so the new one picks up `initialExpansion: 'open' |
    // 'closed'` from scratch. Without this, switching from Whole-repo
    // (closed) into Changed-only would still render every directory
    // collapsed since `resetPaths` doesn't re-apply the shorthand.
    if (tree !== null && liveExpansion !== expansion) {
      tree.cleanUp();
      tree = null;
    }

    if (tree === null) {
      // Read the current search query without tracking — we're
      // already inside an `untrack` block but the dedicated effect
      // below handles propagation from prop → tree. Reading here
      // just seeds the brand-new tree so the very first paint after
      // a rebuild already reflects the active query (e.g. if a PR
      // switch happened to land while a query was live; today the
      // store-level reset clears it, but this stays correct under
      // future reset-policy changes).
      const initialQuery = searchQuery && searchQuery.length > 0 ? searchQuery : null;

      // Track the last path forwarded via onSelect so we can detect
      // re-clicks on the already-selected file. Seeded with the
      // initial selection so the very first re-click is caught even
      // before `onSelectionChange` has fired once.
      let lastEmittedPath: string | null = activePath;

      tree = new FileTree({
        paths: withPhantomPaths(currentPaths),
        initialExpansion: expansion,
        initialSelectedPaths: initialSelected,
        initialSearchQuery: initialQuery,
        gitStatus: initialGitStatus,
        // ── Folder name colour ────────────────────────────────────────
        // File rows whose git status is set (added / modified / …)
        // already get their content tinted by the library's base
        // stylesheet via `[data-item-git-status]`. Directories that
        // contain a changed descendant get
        // `[data-item-contains-git-change="true"]` but only have
        // their tiny git-lane indicator coloured by default —
        // the folder name itself stays muted, which makes it
        // easy to miss a change buried deep in the tree. Inject
        // CSS through the library's `unsafe` layer so the folder
        // content also picks up the modified colour. The
        // `button[data-type='item']` selector keeps specificity
        // higher than the base layer's plain `[data-type='item']`,
        // so the override wins inside the shadow root.
        //
        // ── Badge font via unsafeCSS ──────────────────────────────
        // Badge COLOURS are handled by syncStatsStyle() which injects
        // a separate style element (id=revv-stat-colors) keyed on
        // data-item-path so they survive virtual-render passes and
        // work regardless of the file's git-status attribute value
        // (modified files are always "modified" even if they only
        // have additions — git-status alone can't distinguish
        // direction).
        unsafeCSS: `
						button[data-type='item'][data-item-contains-git-change='true'] > [data-item-section='content'] {
							color: var(--trees-git-modified-color);
						}
						/* Monospace font for the per-path stat pseudos. The actual
						 * "-D" / "+A" text lives in the ::before / ::after content
						 * (set by syncStatsStyle()); the inner <span> the library
						 * renders is left empty by renderRowDecoration, so styling
						 * the span itself does nothing. */
						button[data-type='item'] > [data-item-section='decoration']::before,
						button[data-type='item'] > [data-item-section='decoration']::after {
							font-family: var(--font-mono, ui-monospace, monospace);
							font-size: 10px;
							letter-spacing: -0.02em;
							/* Defensive: tabular figures in case the
							 * monospace fallback ever lands on a font with
							 * proportional digits. */
							font-variant-numeric: tabular-nums;
							/* Two fixed-width slots make the LOC column read
							 * as an actual column, not a ragged trailing tag.
							 * \`-N\` sits in the leading slot, \`+N\` in the
							 * trailing one. Without min-widths the cell
							 * sizes to its content and the column's leading
							 * edge zigzags per row (\`+478\` vs \`-9 +160\` vs
							 * \`+1\`). */
							display: inline-block;
							text-align: end;
						}
						button[data-type='item'] > [data-item-section='decoration']::before {
							/* \`-DD\` fits in 2.25em at 10px mono. Longer
							 * deletion counts just push the slot wider — we
							 * never want to clip a real number. */
							min-width: 2.25em;
						}
						button[data-type='item'] > [data-item-section='decoration']::after {
							/* \`+DDD\` fits in 2.5em — additions tend to run
							 * larger than deletions in PR stats. */
							min-width: 2.5em;
						}
						/* The library reserves a fixed scrollbar gutter via
						 * \`scrollbar-gutter: stable\` and an asymmetric padding-inline
						 * formula that subtracts the gutter from the right side. On
						 * macOS (overlay scrollbars) this leaves a permanent ~6px
						 * dead zone on the right edge that doesn't exist in the PR
						 * list — which uses plain \`overflow-y: auto\`, so the
						 * scrollbar overlays content when needed. Match that behavior
						 * here: drop the stable gutter and force symmetric 2px
						 * padding so each row's effective inset (2px container + 2px
						 * item-margin + 8px item-padding = 12px) matches \`px-3\` on
						 * both sides. */
						[data-file-tree-virtualized-scroll='true'] {
							scrollbar-gutter: auto;
							padding-inline: 2px;
							/* Suppress vertical rubber-band / scroll-chaining to the
							 * parent. The trailing scroll room that lets the last
							 * file clear the bottom \`.sidebar-fade\` comes from the
							 * phantom rows appended to the path set (see
							 * PHANTOM_PATHS above); CSS padding-block-end would be
							 * snapped back instantly by FileTreeView's update loop. */
							overscroll-behavior: contain;
						}
						/* Phantom rows exist solely to extend the library's
						 * \`maxScrollTop\` so the real last file can scroll above
						 * the \`.sidebar-fade\` overlay. Hide their content (the
						 * row content/decoration/indent cells) and kill all
						 * pointer + selection affordances, but keep the row
						 * button laid out so the virtualizer still reserves
						 * \`itemHeight\` for each one. \`visibility: hidden\`
						 * propagates to descendants, leaving the row entirely
						 * invisible while still occupying its \`top:index*itemHeight\`
						 * slot in the absolutely-positioned list. */
						button[data-type='item'][data-item-path^='${PHANTOM_PATH_PREFIX}'] {
							visibility: hidden;
							pointer-events: none;
						}
						/* ── Filename truncation + fixed LOC gutter ─────────────
						 * Pierre absolute-positions every row with inline
						 * \`left:0; right:0\` and middle-truncates the filename
						 * (keeping the extension) once it overflows. That's the
						 * behavior we want, so we DON'T override row sizing — rows
						 * fill the viewport and the name truncates to fit. The
						 * only nudge the content cell needs is \`min-width: 0\` so
						 * it can shrink below its intrinsic width and let
						 * MiddleTruncate engage. */
						button[data-type='item'] > [data-item-section='content'] {
							min-width: 0;
						}
						/* Decoration cell: a plain fixed-width trailing gutter.
						 * The name truncates *before* it, so the LOC count is
						 * always fully visible at any panel width — no sticky, no
						 * mask, no horizontal scroll. \`margin-inline-start: auto\`
						 * parks it at the row's trailing edge; \`min-width\`
						 * reserves the column even for additions-only files (\`+1\`)
						 * so the leading edge doesn't zigzag row to row.
						 * \`padding-inline-start\` is kept tight (the gap between
						 * the filename and the count) so the name gets the most
						 * room and truncates as late as possible. \`pad-start +
						 * 2.25em + 4px gap + 2.5em\` ≈ 6 + 22 + 4 + 25 = 57px. */
						button[data-type='item'] > [data-item-section='decoration'] {
							flex: 0 0 auto;
							margin-inline-start: auto;
							padding-inline-start: 6px;
							min-width: 58px;
						}
					`,
        // ── Right-side line-count badge ────────────────────────────
        // Returns an empty span — the actual "-D" (red) and "+A"
        // (green) text is rendered via per-path `::before`/`::after`
        // rules injected by `syncStatsStyle()`. We need the
        // decoration cell to exist (non-null return) so the
        // pseudo-elements have a host; an empty `text` is the
        // minimum that achieves that.
        renderRowDecoration: (ctx) => {
          if (ctx.item.kind !== "file") return null;
          const stats = statsRef.get(ctx.item.path);
          if (!stats || (stats.additions === 0 && stats.deletions === 0)) {
            return null;
          }
          return { text: "" };
        },
        onSelectionChange: (selected) => {
          // Forward every selection — directory vs file filtering
          // happens at the consumer (SidebarFilesView) via the path
          // set. Doing it here would require calling getItem during
          // the library's emit, which sits in the middle of the
          // row-click handler (between selectOnlyPath and the
          // directory toggle). Pulling out of that critical
          // section was the only reliable way to keep the
          // library's `item.toggle()` reaching the store.
          //
          // Phantom rows are visually hidden so they shouldn't be
          // reachable by click, but keyboard nav can still focus
          // them — short-circuit those so a stray arrow-down never
          // clears the active diff.
          const first = selected[0];
          if (typeof first === "string" && !isPhantomPath(first)) {
            lastEmittedPath = first;
            onSelect(first);
          }
        },
      });
      tree.render({ containerWrapper: host });
      // Inject per-path colour rules now that the shadow root exists.
      syncStatsStyle();
      liveExpansion = expansion;

      // Re-fire onSelect when the user clicks an already-selected item.
      // `onSelectionChange` only fires on selection *changes*, so
      // re-clicking the active file (common in 1-file PRs or when the
      // user is already on that file) is a no-op without this patch.
      // We listen on the host, run after a microtask so the library's
      // own handler settles first, then check if the selection is still
      // the last emitted path — if so, the user re-clicked it.
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

      // Gate keyboard nav so the arrow / PageDown / End keys can't walk
      // focus into the hidden phantom rows. The library's `onKeyDown`
      // handler lives on the virtualized-root <div> inside the shadow
      // root, so a capture-phase listener on `host` (light DOM) fires
      // first — calling `stopImmediatePropagation` cancels the row
      // handler entirely. Sidebar.handleKeydown's vim translation emits
      // standard `ArrowDown` / `End` keys, so this gate catches both
      // raw arrow input and vim shortcuts.
      if (keyHandler) host.removeEventListener("keydown", keyHandler, true);
      keyHandler = (event: KeyboardEvent) => {
        const key = event.key;
        const isEnd = key === "End" || (key === "ArrowDown" && (event.metaKey || event.ctrlKey));
        const isStep = key === "ArrowDown" || key === "PageDown";
        if (!isEnd && !isStep) return;
        const sr = tree?.getFileTreeContainer()?.shadowRoot;
        if (!sr) return;
        // End / Cmd-ArrowDown always targets the last row in the tree —
        // which is always a phantom — so redirect to the last real row
        // instead of letting the library handle it.
        if (isEnd) {
          const target = findLastRealRowEl(sr);
          if (target == null) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          const path = target.dataset.itemPath;
          if (path) tree?.focusPath(path);
          target.focus();
          return;
        }
        // ArrowDown / PageDown only need gating at the boundary between
        // the last real row and the first phantom. Anywhere else the
        // library's nav is correct.
        const focused = sr.querySelector<HTMLElement>('button[data-type="item"][tabindex="0"]');
        if (focused == null) return;
        const next = nextFlowRow(focused);
        if (next != null && isPhantomPath(next.dataset.itemPath ?? "")) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      };
      host.addEventListener("keydown", keyHandler, true);
    } else {
      // Subsequent updates — replace the path set in place. This
      // preserves scroll/expand state for unchanged subtrees, which
      // matters when the user pulls a new commit (most paths
      // unchanged) more than when they switch PRs (mostly different).
      tree.resetPaths(withPhantomPaths(currentPaths));
      tree.setGitStatus(initialGitStatus);
      syncStatsStyle();
    }
  });
});

// Sync git-status decoration without rebuilding the tree.
$effect(() => {
  const map = statusByPath;
  if (!tree) return;
  untrack(() => tree?.setGitStatus(buildGitStatus(map)));
});

// Drive the library's search session from the `searchQuery` prop. Kept
// strictly separate from the rebuild effect above — `setSearch` is a
// cheap projection update inside the controller (no virtual DOM tear-
// down) so it must not pull in the rebuild path. `null` is Pierre's
// documented "clear" value (FileTreeController.js:644 closeSearch ≙
// setSearch(null)); empty string would also work but `null` matches the
// closeSearch path exactly and avoids a stray empty-search projection.
$effect(() => {
  const query = searchQuery;
  if (!tree) return;
  untrack(() => {
    tree?.setSearch(query && query.length > 0 ? query : null);
  });
});

// Mirror programmatic activePath changes into the tree's selection so
// e.g. cmd-palette jumps update the highlighted row. Bails when the
// tree's current selection already matches — important to avoid undoing
// the click-handler's directory toggle (the library's row click does
// `selectOnlyPath` followed by `item.toggle()`; if our effect re-fires
// `select()` between those, we re-emit `onSelectionChange` and Preact
// schedules a render between the two state changes which can swallow
// the toggle).
//
// Deselect the previously-selected paths *before* selecting the new
// one. `item.select()` is the multi-select primitive: it appends to
// the current selection. If we just call `item.select(path)` while a
// previous path is still selected, `onSelectionChange` fires with
// `[oldPath, newPath]`, and the SidebarFilesView consumer reads
// `selected[0]` (the *old* path) and re-applies it via
// `setActiveFilePath`, undoing the jumpToDiffLine that triggered this
// effect (e.g. clicking opportunity.service.ts badge from walkthrough
// would land back on the previously-viewed campaign.repository.ts).
$effect(() => {
  const path = activePath;
  if (!tree) return;
  untrack(() => {
    if (path == null) return;
    const current = tree?.getSelectedPaths() ?? [];
    if (current.length === 1 && current[0] === path) return;
    for (const p of current) {
      if (p !== path) tree?.getItem(p)?.deselect();
    }
    tree?.getItem(path)?.select();
  });
});

// Focus the host on mount / on demand so the library's built-in arrow-key
// nav kicks in. Sidebar.handleKeydown translates vim-style j/k/l/h into
// arrow events that the focused row inside `host` then handles. Without
// this, the tree never receives focus and keyboard nav dead-ends.
$effect(() => {
  if (!shouldFocus) return;
  if (!host) return;
  untrack(() => {
    // Defer to next frame so the layout is stable. The library mounts
    // row buttons asynchronously after `render()`.
    requestAnimationFrame(() => {
      if (activePath != null && tree != null) {
        // Restore the focus cursor to the active file so that
        // navigation (j/k/h/l) resumes from where the user left
        // off instead of jumping to the top of the list.
        //
        // selectOnlyPath (called on file open) does NOT set the
        // controller's focusedPath — selection and focus are
        // separate in @pierre/trees.  focusPath() syncs them and
        // also scrolls the row into the virtual viewport.
        //
        // The Preact re-render that applies the new tabIndex="0"
        // to the focused button is asynchronous, so we wait one
        // more frame before calling element.focus() to ensure
        // we land on the right button.
        tree.focusPath(activePath);
        requestAnimationFrame(() => {
          const sr = tree?.getFileTreeContainer()?.shadowRoot;
          // After re-render, the focused row has tabIndex=0.
          const row =
            sr?.querySelector<HTMLElement>('[data-type="item"][tabindex="0"]') ??
            sr?.querySelector<HTMLElement>('[data-type="item"]');
          if (row) row.focus();
          else host.focus();
        });
      } else {
        // No active file yet — focus the first visible row so
        // arrow-key navigation has a starting point.
        const container = tree?.getFileTreeContainer();
        const firstRow = container?.shadowRoot?.querySelector<HTMLElement>('[data-type="item"]');
        if (firstRow) {
          firstRow.focus();
        } else {
          host.focus();
        }
      }
    });
  });
});

// Re-focus the active row each time the sidebar panel regains control
// after a diff mode (Escape / Space / h from diff). `shouldFocus` handles
// the view-switch path (PR list → files) but stays true throughout diff
// navigation, so it can never fire again on return. `panelActive` goes
// false → true on every panel-return, filling that gap.
$effect(() => {
  if (!panelActive) return;
  if (!host) return;
  let frameId: number;
  untrack(() => {
    frameId = requestAnimationFrame(() => {
      if (activePath != null && tree != null) {
        tree.focusPath(activePath);
        frameId = requestAnimationFrame(() => {
          if (!host) return;
          const sr = tree?.getFileTreeContainer()?.shadowRoot;
          const row =
            sr?.querySelector<HTMLElement>('[data-type="item"][tabindex="0"]') ??
            sr?.querySelector<HTMLElement>('[data-type="item"]');
          if (row) row.focus();
          else host.focus();
        });
      } else {
        if (!host) return;
        const container = tree?.getFileTreeContainer();
        const firstRow = container?.shadowRoot?.querySelector<HTMLElement>('[data-type="item"]');
        if (firstRow) firstRow.focus();
        else host.focus();
      }
    });
  });
  return () => cancelAnimationFrame(frameId);
});

onDestroy(() => {
  // `cleanUp` performs full teardown: detaches DOM, drops listeners,
  // releases the path-store. Calling on a never-mounted instance is
  // safe but tree is null in that case so we don't bother.
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
		/* Force the tree into dark-mode rendering regardless of the user's
		   system preference. The tree's CSS uses `light-dark()` and reads
		   `color-scheme` from the host element, so we have to set it on the
		   *host* (this div) for the inner shadow root to inherit it. */
		color-scheme: dark;

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
		/* Hover state — soft tint over the secondary bg, matching how the
		   PR list rows feel on hover. */
		--trees-bg-muted-override: var(--color-bg-tertiary);
		/* Match the PR list's px-3 (12px) left/right padding.
		   Effective row indent = max(inline - item-margin, 0) + item-margin + item-padding-x
		                        = max(4px - 2px, 0) + 2px + 8px = 12px */
		--trees-padding-inline-override: 4px;
		/* Fixed per-level indent — tighter than the library default (8px) to
		   leave more room for filenames, but constant: it never reacts to panel
		   width or truncation. */
		--trees-level-gap-override: 4px;
	}

	.pierre-tree-host:focus {
		outline: none;
	}
</style>
