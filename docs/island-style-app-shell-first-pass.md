# Island-style app shell — first pass

## Context

The app shell currently reads as a flat 3-pane grid: warm off-white topbar (`--color-bg-primary`) with a hairline bottom border, sidebar in a slightly darker warm gray (`--color-bg-secondary`) separated from the main content by a 1px border, and main content in the same off-white as the topbar. There's no visual hierarchy between "chrome" and "content"; everything reads as one continuous surface delimited by hairlines.

We're shifting to an **island aesthetic** (Linear/Arc/macOS-native sidebar feel) where:

- The **chrome** (topbar + rail + sidebar + bottombar) shares a single warm-gray tone (`--color-bg-secondary`) and reads as one continuous canvas.
- The **main pane** floats inside that chrome as a lighter, rounded card (`--color-bg-primary`), with a 10px gap on all four sides and 12px corner radius.
- Internal hairline borders between chrome panes are removed so the chrome is a true canvas, not a grid of cells.

User-approved scope: **full island** (gap top/right/bottom/left + all 4 corners rounded), **standard sizing** (10px gap, 12px radius).

## Files to modify

### 1. `apps/web/src/app.css`

Add two tokens to the `@theme` block, next to the existing `--radius-card: 8px;` (line 510):

```css
/* Radii */
--radius-card: 8px;
--radius-island: 12px;

/* Layout — island gap (chrome → main pane) */
--spacing-island: 10px;
```

`@theme` is the canonical location for design tokens in this project (radius lives there; spacing as `--spacing-*` follows Tailwind v4 convention and stays reachable via `var()` in component `<style>` blocks).

### 2. `apps/web/src/lib/components/layout/AppShell.svelte`

All edits land in the `<style>` block. No markup changes needed — the existing grid (`'topbar topbar topbar' / 'rail sidebar main' / 'rail sidebar bottombar'`) already supports the island treatment; we just restyle the cells.

**`.app-shell` (line 689)** — flip the outer canvas to chrome tone so the gap around `.main-area` shows the warm-gray (instead of the current primary off-white):

```diff
- background-color: var(--color-bg-primary);
+ background-color: var(--color-bg-secondary);
```

**`.sidebar-area` (line 712)** — drop the right border; the gap replaces it:

```diff
.sidebar-area {
    grid-area: sidebar;
    position: relative;
-   border-right: 1px solid var(--color-border);
    overflow: hidden;
}
```

**`.topbar-area` (lines 750–757)** — match the chrome tone and drop the hairline:

```diff
.topbar-area {
    grid-area: topbar;
    position: relative;
    z-index: 10;
    height: 20px;
-   background: var(--color-bg-primary);
-   border-bottom: 1px solid color-mix(in srgb, var(--color-border) 40%, transparent);
+   background: var(--color-bg-secondary);
}
```

**`.main-area` (lines 765–771)** — paint the island, round the corners, inset by the gap, add a soft border so the edge is defined against the chrome (without it the radius reads as washed-out at the corner highlights):

```diff
.main-area {
    grid-area: main;
    overflow: hidden;
    min-height: 0;
    min-width: 0;
+   background: var(--color-bg-primary);
+   border: 1px solid var(--color-border-subtle);
+   border-radius: var(--radius-island);
+   margin: var(--spacing-island);
}
```

**`.bottombar-area` (lines 803–806)** — drop the top border so the bottombar merges with the sidebar/topbar into one continuous chrome region:

```diff
.bottombar-area {
    grid-area: bottombar;
-   border-top: 1px solid var(--color-border);
}
```

**Leave alone:**
- `.rail-area` border-right (line 704). Rail already paints `--color-bg-secondary` (`ProjectRail.svelte:162`), so it visually joins the chrome. The 1px divider between rail and sidebar preserves the project-switcher's identity — removing it is a separate aesthetic call I'd rather make after seeing the rest land.
- `.rightpanel-area` (lines 862–877). It overlays the main pane and already uses `--color-panel-bg` (= secondary). Whether it should also become an island (inset + rounded) when open is a follow-up — the user didn't ask, and the slide-in transform currently anchors to viewport edge.
- `.tabs-float` (top: 100% of topbar + 12px padding) and `.walkthrough-actions-float` (bottom: 40px + 12px padding). Geometry shifts by ~10px, but both are still tethered to the topbar/bottombar in viewport coordinates and will land at the main pane's top/bottom edges — visually they'll appear to "hang" from the topbar and "rise" from the bottombar, which reads correctly with the island.

### 3. `apps/web/src/lib/components/layout/BottomBar.svelte`

Line 71 currently uses `bg-bg-primary`, which would now contrast against the chrome. Flip to the chrome tone so the bottombar dissolves into the canvas:

```diff
- <div class="flex h-full items-center justify-between bg-bg-primary px-4">
+ <div class="flex h-full items-center justify-between bg-bg-secondary px-4">
```

## What this looks like when done

- Topbar, rail, sidebar, bottombar all share `#f4f1eb` (the warm gray). No internal hairlines except the rail/sidebar divider.
- A single warm-gray "frame" 10px thick wraps the main pane on all four sides.
- Main pane is `#faf9f6` with a 12px radius and a subtle `--color-border-subtle` outline. Floats inside the chrome like Linear's main editor or Arc's web view.
- Dark theme inherits cleanly — `--color-bg-secondary` is `#111111` and `--color-bg-primary` is `#0a0a0a` in dark mode, so the same contrast relationship holds.

## Verification

End-to-end visual check (no tests are needed for purely cosmetic CSS changes):

1. `make dev` — boot all three services.
2. **Open the app in browser at `localhost:5173`** (not Tauri first; the Tauri overlay title bar adds an extra 22px padding on the topbar that's worth sanity-checking separately).
3. Visit any route with a PR open (`/repo/[repoId]/pr/[prId]`) — verify:
   - Topbar background matches the sidebar background (no visible seam between them).
   - No bottom hairline under the topbar.
   - 10px warm-gray gap visible above, left, right, and below the main pane.
   - Main pane corners are visibly rounded (12px).
   - `FloatingTabs` still appears centered over the main pane, not floating in the gap awkwardly. (Geometry note: tabs sit ~12px below topbar bottom, which is now ~2px below the main pane's top edge — they should still look anchored to the topbar.)
   - `walkthrough-actions-float` still appears centered above the bottombar.
4. **Toggle the right panel** (chat). Verify:
   - Panel slides in from `right: 0` and covers the main pane's right gap. No visible "double chrome stripe" between panel and main.
   - When closed, the 10px gap on main's right is restored.
5. **Resize the sidebar.** Verify the gap between sidebar and main stays a clean 10px during the drag (no jitter, no border peeking through).
6. **Switch to dark theme** (Settings → appearance). Verify the chrome / island contrast still reads correctly (`#111` chrome → `#0a0a0a` island).
7. **Open in Tauri** (`make dev` launches it). Verify the topbar is 28px tall (overlay title bar clearance), the traffic lights sit cleanly in the chrome tone, and the gap math still works.

## Out of scope for this pass

- Rail/sidebar divider treatment (whether to remove the 1px line between rail and sidebar).
- Right panel as an island (rounded + inset when open).
- Shadow vs. border for the main pane's edge definition (currently using `--color-border-subtle`; a soft drop shadow is the natural alternative).
- Per-page background adjustments inside main (any page that hard-codes `--color-bg-primary` for its content area is unaffected since main itself is now that color).

These are all natural follow-ups once the headline transformation lands and the user reacts to it.
