# Harmonize Transition Durations — Implementation Plan

## Token to Add

```css
/* In app.css @theme block, after --duration-ceremonial-slow */
--duration-pulse: 1400ms; /* decorative infinite-loop animations */
```

## File-by-File Changes

### 1. `apps/web/src/app.css`

**Line 533** — Add `--duration-pulse: 1400ms;` after `--duration-ceremonial-slow`

**Line 659** — `ease-out` → `var(--ease-out-expo)`
```css
/* Before */
transition: opacity var(--text-shimmer-swap) ease-out;
/* After */
transition: opacity var(--text-shimmer-swap) var(--ease-out-expo);
```

**Line 916** — `1.5s ease-in-out` → `var(--duration-pulse) var(--ease-soft)`
```css
/* Before */
animation: indeterminate-progress 1.5s ease-in-out infinite;
/* After */
animation: indeterminate-progress var(--duration-pulse) var(--ease-soft) infinite;
```

**Line 1007** — `300ms cubic-bezier(0, 0, 0.58, 1)` → `var(--duration-ceremonial-quick) var(--ease-soft)`
```css
/* Before */
animation: sd-char-in 300ms cubic-bezier(0, 0, 0.58, 1) both;
/* After */
animation: sd-char-in var(--duration-ceremonial-quick) var(--ease-soft) both;
```

---

### 2. `apps/web/src/lib/components/ui/dialog/dialog-overlay.svelte`

**Line 15** — `duration-100` → `duration-instant`
```html
<!-- Before -->
class={cn("... duration-100 ...")}
<!-- After -->
class={cn("... duration-instant ...")}
```

---

### 3. `apps/web/src/lib/components/ui/switch/switch.svelte`

**Line 26** — `duration-200` → `duration-quick`
```html
<!-- Before -->
class={cn("... transition-transform duration-200 ...")}
<!-- After -->
class={cn("... transition-transform duration-quick ...")}
```

**Line 47** — Strip fallback literals
```css
/* Before */
transition: transform var(--duration-quick, 200ms) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));
/* After */
transition: transform var(--duration-quick) var(--ease-out-expo);
```

---

### 4. `apps/web/src/lib/components/layout/RightPanel.svelte`

**Line 1450** — `220ms` → `var(--duration-smooth)`
```css
/* Before */
animation: push-pill-pulse 220ms var(--ease-out-expo);
/* After */
animation: push-pill-pulse var(--duration-smooth) var(--ease-out-expo);
```

**Line 1754** — `220ms cubic-bezier(0.22, 0.61, 0.36, 1)` → both tokens
```css
/* Before */
transition: top 220ms cubic-bezier(0.22, 0.61, 0.36, 1);
/* After */
transition: top var(--duration-smooth) var(--ease-standard);
```

---

### 5. `apps/web/src/lib/components/layout/ChatTimeline.svelte`

**Line 466** — Same pattern as RightPanel:1754
```css
/* Before */
transition: top 220ms cubic-bezier(0.22, 0.61, 0.36, 1);
/* After */
transition: top var(--duration-smooth) var(--ease-standard);
```

---

### 6. `apps/web/src/lib/components/ai/context/ContextTrigger.svelte`

**Line 77** — `240ms` → `var(--duration-smooth)`, strip fallback
```html
<!-- Before -->
style="transform: rotate(-90deg); transform-origin: center; transition: stroke-dashoffset 240ms var(--ease-out-expo, ease-out);"
<!-- After -->
style="transform: rotate(-90deg); transform-origin: center; transition: stroke-dashoffset var(--duration-smooth) var(--ease-out-expo);"
```

---

### 7. `apps/web/src/lib/components/walkthrough/ratings-panel/RatingTestRow.svelte`

**Line 335** — `1.2s ease-in-out` → `var(--duration-pulse) var(--ease-soft)`
```css
/* Before */
animation: pulse-gutter 1.2s ease-in-out infinite;
/* After */
animation: pulse-gutter var(--duration-pulse) var(--ease-soft) infinite;
```

**Line 341** — `320ms` → `var(--duration-slow)` (already correct token usage, no change needed — `var(--ease-out-expo)` is already used)

**Line 387** — `180ms` → `var(--duration-quick)`
```css
/* Before */
animation: icon-in 180ms var(--ease-out-expo) 1;
/* After */
animation: icon-in var(--duration-quick) var(--ease-out-expo) 1;
```

**Line 439** — `220ms ease-out` → both tokens
```css
/* Before */
animation: rationale-pulse 220ms ease-out 1;
/* After */
animation: rationale-pulse var(--duration-smooth) var(--ease-out-expo) 1;
```

**Line 501** — `180ms` → `var(--duration-quick)`
```css
/* Before */
animation: row-resolve 180ms var(--ease-out-expo) 1;
/* After */
animation: row-resolve var(--duration-quick) var(--ease-out-expo) 1;
```

---

### 8. `apps/web/src/lib/components/walkthrough/ratings-panel/RatingGridCell.svelte`

**Line 297** — `180ms` → `var(--duration-quick)`
```css
/* Before */
animation: icon-in 180ms var(--ease-out-expo) 1;
/* After */
animation: icon-in var(--duration-quick) var(--ease-out-expo) 1;
```

**Line 339** — `1.4s ease-in-out` → `var(--duration-pulse) var(--ease-soft)`
```css
/* Before */
animation: cell-pulse 1.4s ease-in-out infinite;
/* After */
animation: cell-pulse var(--duration-pulse) var(--ease-soft) infinite;
```

**Line 343** — `220ms` → `var(--duration-smooth)` (already uses `var(--ease-out-expo)`, no change needed)

---

### 9. `apps/web/src/lib/components/review/shared/SpecRow.svelte`

**Line 197** — `1.2s ease-in-out` → `var(--duration-pulse) var(--ease-soft)`
```css
/* Before */
animation: spec-row-pulse-gutter 1.2s ease-in-out infinite;
/* After */
animation: spec-row-pulse-gutter var(--duration-pulse) var(--ease-soft) infinite;
```

**Line 303** — `180ms` → `var(--duration-quick)`
```css
/* Before */
animation: spec-row-resolve 180ms var(--ease-out-expo) 1;
/* After */
animation: spec-row-resolve var(--duration-quick) var(--ease-out-expo) 1;
```

---

### 10. `apps/web/src/lib/components/review/issues-panel/IssueTestRow.svelte`

**Line 176** — `0.5s` → `var(--duration-ceremonial-medium)`
```css
/* Before */
animation: issue-row-enter 0.5s var(--ease-out-expo) both;
/* After */
animation: issue-row-enter var(--duration-ceremonial-medium) var(--ease-out-expo) both;
```

---

### 11. `apps/web/src/lib/components/review/comments-panel/CommentTestRow.svelte`

**Line 179** — `0.5s` → `var(--duration-ceremonial-medium)`
```css
/* Before */
animation: comment-row-enter 0.5s var(--ease-out-expo) both;
/* After */
animation: comment-row-enter var(--duration-ceremonial-medium) var(--ease-out-expo) both;
```

---

### 12. `apps/web/src/lib/components/layout/FloatingTabs.svelte`

**Line 149** — `1.4s ease-in-out` → `var(--duration-pulse) var(--ease-soft)`
```css
/* Before */
animation: status-dot-pulse 1.4s ease-in-out infinite;
/* After */
animation: status-dot-pulse var(--duration-pulse) var(--ease-soft) infinite;
```

---

### 13. `apps/web/src/lib/components/ui/dotmatrix/dotmatrix-loader.css`

**Line 83** — `cubic-bezier(0.42, 0, 0.58, 1)` → `var(--ease-soft)`
```css
/* Before */
animation: dotmatrix-legacy-pulse var(--dmx-cycle) cubic-bezier(0.42, 0, 0.58, 1) infinite;
/* After */
animation: dotmatrix-legacy-pulse var(--dmx-cycle) var(--ease-soft) infinite;
```

**Line 93** — `ease-in-out` → `var(--ease-soft)`
```css
/* Before */
animation: dotmatrix-legacy-pulse var(--dmx-cycle) ease-in-out infinite;
/* After */
animation: dotmatrix-legacy-pulse var(--dmx-cycle) var(--ease-soft) infinite;
```

**Line 115** — `180ms cubic-bezier(0.4, 0, 0.2, 1)` → both tokens
```css
/* Before */
transition: opacity 180ms cubic-bezier(0.4, 0, 0.2, 1);
/* After */
transition: opacity var(--duration-quick) var(--ease-soft);
```

---

### 14. `docs/conventions-backlog.md`

Add 14 new closed entries (M-015 through M-028):

```markdown
- M-015 — dialog-overlay: `duration-100` → `duration-instant`
- M-016 — switch: `duration-200` → `duration-quick`; stripped var() fallback literals
- M-017 — RightPanel: `220ms` literals (×2) → `var(--duration-smooth)`; `cubic-bezier(...)` → `var(--ease-standard)`
- M-018 — ChatTimeline: `220ms cubic-bezier(...)` → `var(--duration-smooth) var(--ease-standard)`
- M-019 — ContextTrigger: `240ms` → `var(--duration-smooth)`; stripped var() fallback
- M-020 — RatingTestRow: `180ms` (×2) → `var(--duration-quick)`; `220ms ease-out` → `var(--duration-smooth) var(--ease-out-expo)`; `1.2s ease-in-out` → `var(--duration-pulse) var(--ease-soft)`
- M-021 — RatingGridCell: `180ms` → `var(--duration-quick)`; `1.4s ease-in-out` → `var(--duration-pulse) var(--ease-soft)`
- M-022 — SpecRow: `180ms` → `var(--duration-quick)`; `1.2s ease-in-out` → `var(--duration-pulse) var(--ease-soft)`
- M-023 — IssueTestRow: `0.5s` → `var(--duration-ceremonial-medium)`
- M-024 — CommentTestRow: `0.5s` → `var(--duration-ceremonial-medium)`
- M-025 — FloatingTabs: `1.4s ease-in-out` → `var(--duration-pulse) var(--ease-soft)`
- M-026 — app.css: `ease-out` → `var(--ease-out-expo)`; `1.5s ease-in-out` → `var(--duration-pulse) var(--ease-soft)`; `300ms cubic-bezier(...)` → `var(--duration-ceremonial-quick) var(--ease-soft)`
- M-027 — dotmatrix-loader: `cubic-bezier(0.42, 0, 0.58, 1)` → `var(--ease-soft)`; `ease-in-out` → `var(--ease-soft)`; `180ms cubic-bezier(...)` → `var(--duration-quick) var(--ease-soft)`
- M-028 — Added `--duration-pulse: 1400ms` to app.css @theme block
```

Update summary table: UI / motion → 14 (then all closed).

---

## Mapping Summary

| Hardcoded Value | Token | Rationale |
|---|---|---|
| `duration-100` | `duration-instant` | 80ms is closest (100ms has no token) |
| `duration-200` | `duration-quick` | 160ms is closest |
| `180ms` | `--duration-quick` | 160ms, 20ms diff imperceptible |
| `220ms` | `--duration-smooth` | Exact match |
| `240ms` | `--duration-smooth` | 220ms closest |
| `0.5s` (500ms) | `--duration-ceremonial-medium` | 480ms closest |
| `300ms` | `--duration-ceremonial-quick` | 280ms closest |
| `1.2s` / `1.4s` / `1.5s` | `--duration-pulse` | New token for infinite loops |
| `ease-out` | `--ease-out-expo` | Semantic match (enter animation) |
| `ease-in-out` | `--ease-soft` | Closest canonical easing |
| `cubic-bezier(0.42, 0, 0.58, 1)` | `--ease-soft` | Near-identical curve |
| `cubic-bezier(0.22, 0.61, 0.36, 1)` | `--ease-standard` | Byte-identical |
| `cubic-bezier(0, 0, 0.58, 1)` | `--ease-soft` | Closest canonical easing |
