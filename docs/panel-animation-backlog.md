# Panel Animation Backlog

Tracks follow-up work for sidebar and right-panel animation performance. The current stopgap is intentionally small: large file trees snap the outer grid layout instead of animating `grid-template-columns`, and heavy sidebar panes use CSS containment.

## Summary

| Area | Open | Effort |
|---|---:|---|
| Layout animation | 2 | M/L |
| Heavy subtree containment | 2 | S/M |
| File tree behavior | 2 | S/M |
| PR list behavior | 1 | M |
| **Total** | **7** | |

---

## Done

- [x] **PANEL-001** Snap sidebar grid animation for large file trees — `AppShell.svelte` disables the app-shell grid transition when the sidebar is in files view with at least 120 review files. This avoids frame-by-frame layout through the virtualized file tree during collapse/expand.
- [x] **PANEL-002** Add containment around sidebar heavy panes — `AppShell.svelte`, `Sidebar.svelte`, and `PierreFileTree.svelte` now use `contain: layout paint` at the sidebar area, pane, and tree host boundaries.

---

## Next

- [ ] **PANEL-003** Replace sidebar collapse with a compositor-first animation — keep the sidebar content at a stable internal width and animate a wrapper with `transform` or clipping instead of resizing the grid column every frame. Preserve persisted sidebar width and hover-to-reveal behavior.
- [ ] **PANEL-004** Decide main-pane layout semantics during sidebar animation — choose whether the main pane should snap after the visual transition, animate only below a complexity threshold, or keep the current continuous resize for small sidebars.
- [ ] **PANEL-005** Apply the same compositor-first strategy to the right panel — the right panel currently participates in the same grid-template animation path and remains mounted while closed. Profile first, then either slide/clip the panel or snap the layout after the visual transition.

---

## Later / Opportunistic

- [ ] **PANEL-006** Gate hidden heavy DOM — when the sidebar is collapsed and not peeking, suspend or hide the file-tree pane with `content-visibility` or conditional mounting without breaking focus restoration.
- [ ] **PANEL-007** Add a large-file expansion policy — keep `initialExpansion="open"` for small PRs, but use closed or partial expansion for large PRs so the tree does not maintain a huge flattened visible model by default.
- [ ] **PANEL-008** Reduce per-path file stat CSS pressure — replace per-file injected CSS rules in `PierreFileTree.svelte` with a cheaper row-decoration path if `@pierre/trees` exposes one, or defer stat-style sync away from panel transitions.
- [ ] **PANEL-009** Optimize PR/archive lists if profiling implicates them — `ProjectPrList.svelte` and `ProjectArchiveList.svelte` render all rows and use entrance transitions. Remove/cap transitions first; virtualize only if row count remains a bottleneck.

---

## Verification Checklist

- Sidebar collapse and expand with a large changed-file set.
- Sidebar hover-to-reveal from the project rail.
- PR list to files drawer transition.
- File search and file-tree keyboard navigation.
- Right-panel open, close, and resize.
- Reduced-motion behavior through the global motion contract.
- `make typecheck` and `make lint`.
