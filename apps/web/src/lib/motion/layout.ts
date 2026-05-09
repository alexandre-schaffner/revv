/**
 * Layout / shared-element helpers — the place we earn the full `motion`
 * package's weight. Imports from `motion` (NOT `motion/mini`) are isolated
 * to this file so Vite chunk-splits the heavier surface.
 *
 * Status: stub. Real implementations land alongside the first concrete
 * call sites (rating-cell ↔ popover morph, walkthrough chapter focus
 * follow). Keeping the file present means follow-up PRs add behavior
 * here without re-litigating where layout helpers live.
 *
 * Two helpers planned:
 *
 *   morphInto(fromEl, toEl, options)
 *     FLIP-based cross-element morph. Used when one element conceptually
 *     "becomes" another — e.g., a rating grid cell expanding into a
 *     full-width popover. Both elements must be in the DOM at call time.
 *
 *   flipChildren(parent, options)
 *     Shifts children by their position delta after a layout change.
 *     For repo-group / file-tree expand-collapse, drag reorders, etc.
 *
 * Both helpers MUST honor `prefersReducedMotion()` and handle the
 * "node detached mid-animation" race (return controllers with a
 * stop method that no-ops if the node is gone).
 */

// Intentionally empty until a real call site lands. Don't import `motion`
// here yet — adding the import without consumers triggers Vite to bundle
// the full lib unnecessarily.

export {};
