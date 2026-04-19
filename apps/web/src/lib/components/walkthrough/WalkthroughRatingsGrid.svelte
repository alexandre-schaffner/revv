<script lang="ts">
    import type {
        WalkthroughBlock,
        WalkthroughRating,
        RatingAxis,
        Verdict,
    } from "@revv/shared";
    import { RATING_AXES, RATING_AXIS_LABELS } from "@revv/shared";
    import { SvelteMap } from "svelte/reactivity";
    import RatingSummaryBar from "./ratings-panel/RatingSummaryBar.svelte";
    import RatingSummaryFooter from "./ratings-panel/RatingSummaryFooter.svelte";
    import RatingGridCell, {
        type CellState,
    } from "./ratings-panel/RatingGridCell.svelte";

    interface Props {
        ratings: WalkthroughRating[];
        blocks: WalkthroughBlock[];
        onJump: (blockId: string) => void;
    }

    let { ratings, blocks, onJump }: Props = $props();

    // ── Hide-when-empty guard ────────────────────────────────────
    // Preserve the list-view behavior: nothing renders until the first rating
    // arrives. A cached walkthrough generated before the scorecard feature
    // existed would otherwise show 9 "queued" cells forever.
    const hasAnyRating = $derived(ratings.length > 0);

    // ── Lookup: axis → rating ────────────────────────────────────
    const ratingByAxis = $derived.by(() => {
        const map = new Map<RatingAxis, WalkthroughRating>();
        for (const r of ratings) map.set(r.axis, r);
        return map;
    });

    // ── Counts ───────────────────────────────────────────────────
    const counts = $derived.by(() => {
        let pass = 0;
        let concern = 0;
        let blocker = 0;
        for (const r of ratings) {
            if (r.verdict === "pass") pass++;
            else if (r.verdict === "concern") concern++;
            else blocker++;
        }
        return {
            pass,
            concern,
            blocker,
            total: ratings.length,
            pending: RATING_AXES.length - ratings.length,
        };
    });

    const allPassed = $derived(
        counts.total === RATING_AXES.length &&
            counts.concern === 0 &&
            counts.blocker === 0,
    );

    // ── Cell lifecycle (queued / running / resolved) ─────────────
    // Same derivation as the list view — axes resolve in RATING_AXES order,
    // so an axis is "running" iff it hasn't arrived AND either it's first or
    // the previous axis has resolved. This is a visual approximation (the
    // backend doesn't announce "started axis X") that reads as sequential.
    function cellState(axis: RatingAxis, index: number): CellState {
        if (ratingByAxis.has(axis)) return "resolved";
        if (index === 0) return "running";
        const prevAxis = RATING_AXES[index - 1];
        if (prevAxis && ratingByAxis.has(prevAxis)) return "running";
        return "queued";
    }

    // ── Per-axis arrival tracking (for total elapsed) ───────────
    // The grid doesn't show per-cell durations (they were a test-runner
    // affordance that doesn't translate to the grid cards). But we still
    // track arrivals so the footer can show a total-elapsed value and so
    // cached-replay detection stays consistent with the list view.
    const mountTime = Date.now();
    const arrivals = new SvelteMap<RatingAxis, number>();
    let firstArrivalTime = $state<number | null>(null);

    $effect(() => {
        // Touch `ratings.length` so the effect re-runs on stream updates; the
        // actual work is idempotent via `arrivals.has()`.
        const now = Date.now();
        if (ratings.length > 0 && firstArrivalTime === null) {
            firstArrivalTime = now;
        }
        for (const r of ratings) {
            if (!arrivals.has(r.axis)) arrivals.set(r.axis, now);
        }
    });

    // Cached replay detection — if all 9 arrived within 200ms of mount, we're
    // almost certainly replaying a stored walkthrough. Showing an elapsed of
    // "0ms" would be misleading, so we suppress it (null) in that case.
    const isCachedReplay = $derived(
        ratings.length === RATING_AXES.length &&
            firstArrivalTime !== null &&
            firstArrivalTime - mountTime < 200,
    );

    // Total elapsed — from first arrival to last arrival. Null until all 9
    // have landed so the number isn't jumpy mid-stream.
    const totalElapsedMs = $derived.by(() => {
        if (ratings.length < RATING_AXES.length) return null;
        if (firstArrivalTime === null) return null;
        if (isCachedReplay) return null;
        let latest = firstArrivalTime;
        for (const axis of RATING_AXES) {
            const t = arrivals.get(axis);
            if (t !== undefined && t > latest) latest = t;
        }
        return latest - firstArrivalTime;
    });

    const runningCount = $derived.by(() => {
        let n = 0;
        for (let i = 0; i < RATING_AXES.length; i++) {
            const axis = RATING_AXES[i];
            if (!axis) continue;
            if (cellState(axis, i) === "running") n++;
        }
        return n;
    });

    // ── "Only failing" filter ───────────────────────────────────
    // In the grid we DIM pass cells rather than remove them from layout —
    // removing would create a jagged shape and defeat the purpose of the 3×3
    // arrangement. Users still get visual emphasis on concerns/blockers
    // without losing the spatial map they've already learned.
    let onlyFailing = $state(false);

    function toggleOnlyFailing(): void {
        onlyFailing = !onlyFailing;
    }

    // ── "Expand all" — intentionally a no-op in grid view ───────
    // The list view's expand-all concept applies to Collapsibles (persistent
    // expanded state). Popovers are transient and mutually exclusive — only
    // one can be open at a time — so there's no meaningful "expand all". We
    // keep the control present so the summary bar reads the same across both
    // views, but clicking is a visual no-op.
    const expandAll = null as boolean | null;

    function toggleExpandAll(): void {
        // intentionally empty — see note above.
    }

    // ── Screen-reader live announcements ─────────────────────────
    // Copied verbatim from WalkthroughRatingsPanel.svelte:211–233 so grid
    // users and list users hear identical phrasing. When a burst of ratings
    // arrives in the same tick (cached replay), the final srMessage
    // assignment wins and the live region reads only one message — natural
    // throttling without explicit time gating.
    let srMessage = $state("");
    const announcedAxes = new Set<RatingAxis>();

    const verdictSpoken: Record<Verdict, string> = {
        pass: "passed",
        concern: "raised a concern",
        blocker: "flagged a blocker",
    };

    $effect(() => {
        for (const r of ratings) {
            if (announcedAxes.has(r.axis)) continue;
            announcedAxes.add(r.axis);
            srMessage = `${RATING_AXIS_LABELS[r.axis]} ${verdictSpoken[r.verdict]} with ${r.confidence} confidence`;
        }
    });

    // ── Keyboard navigation (2-D) ───────────────────────────────
    // Pre-populated with all 9 axes so the Record type stays total. Refs are
    // bound by each <RatingGridCell> and read only by the arrow-key handler.
    const cellRefs: Record<RatingAxis, HTMLElement | null> = {
        correctness: null,
        scope: null,
        tests: null,
        clarity: null,
        safety: null,
        consistency: null,
        api_changes: null,
        performance: null,
        description: null,
    };

    // Columns per row — must match the CSS grid `repeat(3, ...)`. Narrow
    // container queries collapse the grid visually but the logical axis
    // order stays the same, so 2-D navigation continues to feel natural.
    const GRID_COLS = 3;

    function focusAxis(axis: RatingAxis): void {
        const el = cellRefs[axis];
        if (el) el.focus();
    }

    function onGridKeydown(e: KeyboardEvent): void {
        const target = e.target as HTMLElement | null;

        // Find which axis owns the focused element.
        const targetAxis = RATING_AXES.find((a) => cellRefs[a] === target);
        if (targetAxis === undefined) return;

        const idx = RATING_AXES.indexOf(targetAxis);
        const row = Math.floor(idx / GRID_COLS);
        const col = idx % GRID_COLS;
        const lastRow = Math.floor((RATING_AXES.length - 1) / GRID_COLS);

        let nextIdx: number | null = null;

        if (e.key === "ArrowRight") {
            // Clamp within the current row so ArrowRight at the end of row 1
            // doesn't wrap into row 2 (which would feel unpredictable).
            const maxColThisRow = Math.min(
                GRID_COLS - 1,
                RATING_AXES.length - 1 - row * GRID_COLS,
            );
            if (col < maxColThisRow) nextIdx = idx + 1;
        } else if (e.key === "ArrowLeft") {
            if (col > 0) nextIdx = idx - 1;
        } else if (e.key === "ArrowDown") {
            if (row < lastRow) {
                // Clamp to the actual last row length so ArrowDown from the
                // last column of row 2 doesn't overshoot an uneven final row.
                const candidate = idx + GRID_COLS;
                nextIdx = Math.min(candidate, RATING_AXES.length - 1);
            }
        } else if (e.key === "ArrowUp") {
            if (row > 0) nextIdx = idx - GRID_COLS;
        } else if (e.key === "Home") {
            nextIdx = 0;
        } else if (e.key === "End") {
            nextIdx = RATING_AXES.length - 1;
        } else {
            return;
        }

        if (nextIdx === null) return;
        e.preventDefault();
        const next = RATING_AXES[nextIdx];
        if (next) focusAxis(next);
    }
</script>

{#if hasAnyRating}
    <!-- Keydown lives on the section because key events naturally bubble from
         cell triggers (interactive buttons) — the section itself is not made
         into an interactive element. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <section
        class="ratings-grid-panel"
        aria-label="PR quality checks"
        onkeydown={onGridKeydown}
        role="group"
    >
        <!-- Live-region for streaming announcements. Polite + atomic=false
             so each update speaks without wiping the previous. -->
        <div class="sr-only" aria-live="polite" aria-atomic="false">
            {srMessage}
        </div>

        <RatingSummaryBar
            {counts}
            {runningCount}
            {totalElapsedMs}
            {expandAll}
            {onlyFailing}
            onToggleExpandAll={toggleExpandAll}
            onToggleOnlyFailing={toggleOnlyFailing}
        />

        <div
            class="rating-grid"
            class:rating-grid--only-failing={onlyFailing}
            role="list"
        >
            {#each RATING_AXES as axis, i (axis)}
                {@const rating = ratingByAxis.get(axis) ?? null}
                {@const state = cellState(axis, i)}
                <div class="rating-grid-item" role="listitem">
                    <RatingGridCell
                        {axis}
                        {rating}
                        {state}
                        {blocks}
                        {onJump}
                        bind:triggerRef={cellRefs[axis]}
                    />
                </div>
            {/each}
        </div>

        <RatingSummaryFooter {counts} {totalElapsedMs} {allPassed} />
    </section>
{/if}

<style>
    .ratings-grid-panel {
        /* Scoped tokens — shared with the list view so nested cell components
           (RatingGridCell, RatingExpandedBody) can read the same vocabulary. */
        --grid-line: color-mix(
            in srgb,
            var(--color-border) 60%,
            transparent
        );

        display: flex;
        flex-direction: column;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: 10px;
        overflow: hidden;
        font-family: var(--font-mono);
        /* Container-query context so narrow widths can reshape the grid.
           Different container-name than `ratings` so the list view's
           narrow-width rules don't accidentally apply to grid cells. */
        container-type: inline-size;
        container-name: ratings-grid;
    }

    .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
    }

    /* ── Grid ────────────────────────────────────────────────────── */

    .rating-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        /* 1px gap with cells holding their own borders-via-background
           produces a hairline grid — the "grid of lines" feel from the
           reference design. */
        gap: 1px;
        background: var(--grid-line);
        /* Top/bottom separators handled by the summary bar's bottom border
           (.summary-divider inside RatingSummaryBar) and the footer's
           top border respectively. */
    }

    .rating-grid :global(.cell) {
        /* Fill the grid slot. The 1px `gap` + hairline background reveals
           between cells provides the separator lines without needing per-cell
           borders (which would double up at adjacencies). */
        width: 100%;
        height: 100%;
    }

    /* "Only failing": dim pass cells instead of removing them so the grid
       shape stays intact. Pointer-events stay on — users can still open the
       pass popover to read "why it passed" — but the opacity drop pushes the
       eye toward failing cells. */
    .rating-grid--only-failing :global(.cell--pass) {
        opacity: 0.3;
    }

    /* ── Narrow-width container queries ──────────────────────────── */

    /* Below 680px we collapse to 2 columns — still grid-shaped but cell
       content has room to breathe. Below 440px (uncommon but defensive) we
       stack to a single column. */
    @container ratings-grid (max-width: 680px) {
        .rating-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
    }

    @container ratings-grid (max-width: 440px) {
        .rating-grid {
            grid-template-columns: 1fr;
        }
    }
</style>
