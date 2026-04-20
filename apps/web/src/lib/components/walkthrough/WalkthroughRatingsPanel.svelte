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
    import RatingTestRow, {
        type RowState,
    } from "./ratings-panel/RatingTestRow.svelte";

    interface Props {
        ratings: WalkthroughRating[];
        blocks: WalkthroughBlock[];
        onJump: (blockId: string) => void;
    }

    // `blocks` is passed through to RatingExpandedBody so the "block #N" chips
    // can show the block's GLOBAL position in the walkthrough (e.g. "step 7")
    // rather than its 1-based index inside this rating's blockIds array, and so
    // chips for blockIds that don't resolve to a rendered block can be silently
    // dropped instead of appearing broken.
    let { ratings, blocks, onJump }: Props = $props();

    // ── Hide-when-empty guard ────────────────────────────────────
    // Preserve the original behavior: until the first rating arrives, the
    // panel stays hidden. A cached walkthrough generated before this feature
    // existed would otherwise show nine "queued" rows forever.
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

    // ── Row lifecycle (queued / running / resolved) ─────────────
    // Derivation heuristic: axes resolve in RATING_AXES order. An axis is
    // "running" iff it hasn't arrived AND either it's first, or the previous
    // axis has resolved. Everything else that hasn't arrived is "queued".
    //
    // This is a visual approximation — the backend doesn't announce "started
    // axis X" — but it produces a convincing sequential feel because ratings
    // genuinely do arrive roughly in that order.
    function rowState(axis: RatingAxis, index: number): RowState {
        if (ratingByAxis.has(axis)) return "resolved";
        if (index === 0) return "running";
        const prevAxis = RATING_AXES[index - 1];
        if (prevAxis && ratingByAxis.has(prevAxis)) return "running";
        return "queued";
    }

    // ── Per-axis duration tracking ──────────────────────────────
    // We track first-seen wall-clock time per axis. The "duration" for axis
    // N is (arrival_N − arrival_{N−1}), mirroring how a test runner shows the
    // marginal cost of each test. For axis 0 we show (arrival_0 − mount_time)
    // which includes any connection / planning latency.
    //
    // SvelteMap gives us reactive .set()/.has()/.get() without the manual
    // re-assignment dance a native Map would need.
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

    // Cached replay detection — if all 9 arrive within 200ms of mount, we're
    // almost certainly replaying a stored walkthrough. Durations would be
    // meaningless ("0ms" across the board), so we show "—" instead.
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
            if (rowState(axis, i) === "running") n++;
        }
        return n;
    });

    // ── Expand / collapse state ──────────────────────────────────
    // Tri-state: `true` = all expanded, `false` = all collapsed, `null` = use
    // per-row state. This lets "Expand all" snapshot cleanly without locking
    // the user out of single-row toggles.
    let expandAll = $state<boolean | null>(null);
    let rowOpen = $state<Partial<Record<RatingAxis, boolean>>>({});

    function isRowOpen(axis: RatingAxis): boolean {
        if (expandAll !== null) return expandAll;
        return rowOpen[axis] ?? false;
    }

    function toggleRow(axis: RatingAxis): void {
        // If we're in expand-all mode, flush the expanded state into per-row
        // first — otherwise the user's single-row click would collapse every
        // OTHER row, which feels hostile.
        if (expandAll !== null) {
            const snapshot: Partial<Record<RatingAxis, boolean>> = {};
            for (const a of RATING_AXES) snapshot[a] = expandAll;
            // Flip only the clicked row.
            snapshot[axis] = !expandAll;
            rowOpen = snapshot;
            expandAll = null;
            return;
        }
        rowOpen = { ...rowOpen, [axis]: !(rowOpen[axis] ?? false) };
    }

    function toggleExpandAll(): void {
        // If any row is currently visually open (either via expandAll or
        // per-row), treat the next click as "collapse all". Otherwise expand.
        const anyOpen =
            expandAll === true ||
            RATING_AXES.some((a) => rowOpen[a] === true);
        expandAll = anyOpen ? false : true;
        rowOpen = {};
    }

    // ── Only-failing filter ──────────────────────────────────────
    let onlyFailing = $state(false);

    function toggleOnlyFailing(): void {
        onlyFailing = !onlyFailing;
    }

    // Visible axes: all 9 by default. When "only failing" is on, we hide
    // resolved-as-pass rows but keep running/queued visible so the user still
    // sees progress.
    const visibleAxes = $derived.by(() => {
        if (!onlyFailing) return [...RATING_AXES];
        return RATING_AXES.filter((axis) => {
            const r = ratingByAxis.get(axis);
            if (!r) return true; // queued/running stay visible
            return r.verdict !== "pass";
        });
    });

    // ── Screen-reader live announcements ─────────────────────────
    // Announce each newly-resolved rating. When a burst of ratings arrives in
    // the same tick (cached replay), the final srMessage assignment wins —
    // the live region naturally speaks only one message, which is the
    // "throttling" the PRD calls for without needing explicit time gating.
    let srMessage = $state("");
    // Non-reactive set: we only read/write it from inside the effect, and
    // mutations shouldn't retrigger the effect.
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

    // ── Keyboard navigation ──────────────────────────────────────
    // Non-reactive: refs are read only from keyboard handlers, never from the
    // template. Pre-populated with all 9 axes so the Record type stays total
    // (no `undefined` surprises when binding).
    const rowRefs: Record<RatingAxis, HTMLElement | null> = {
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

    function focusAxis(axis: RatingAxis): void {
        const el = rowRefs[axis];
        if (el) el.focus();
    }

    function onPanelKeydown(e: KeyboardEvent): void {
        // 'e' toggles expand-all — but only when focus is inside the panel
        // and not in an input/textarea (defensive: there are no inputs in
        // this panel, but a future expansion might add one).
        const target = e.target as HTMLElement | null;
        const isInInput =
            target?.tagName === "INPUT" ||
            target?.tagName === "TEXTAREA" ||
            target?.isContentEditable;

        if (e.key === "e" && !isInInput && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            toggleExpandAll();
            return;
        }

        // Arrow navigation only applies when focus is on a row trigger.
        const targetAxis = visibleAxes.find((a) => rowRefs[a] === target);
        if (targetAxis === undefined) return;

        const idx = visibleAxes.indexOf(targetAxis);
        if (e.key === "ArrowDown") {
            e.preventDefault();
            const next = visibleAxes[Math.min(idx + 1, visibleAxes.length - 1)];
            if (next) focusAxis(next);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            const prev = visibleAxes[Math.max(idx - 1, 0)];
            if (prev) focusAxis(prev);
        } else if (e.key === "Home") {
            e.preventDefault();
            const first = visibleAxes[0];
            if (first) focusAxis(first);
        } else if (e.key === "End") {
            e.preventDefault();
            const last = visibleAxes[visibleAxes.length - 1];
            if (last) focusAxis(last);
        }
    }
</script>

{#if hasAnyRating}
    <!-- Keydown handler lives on the section because key events naturally
         bubble from row triggers (interactive buttons) — we're not turning
         the section itself into an interactive element. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <section
        class="ratings-panel"
        aria-label="PR quality checks"
        onkeydown={onPanelKeydown}
        role="group"
    >
        <!-- Live-region for streaming announcements. Single node, polite, so
             screen reader reads each update without overwhelming. -->
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

        <ul class="rating-rows" role="list">
            {#each RATING_AXES as axis, i (axis)}
                {@const visible = visibleAxes.includes(axis)}
                {#if visible}
                    {@const rating = ratingByAxis.get(axis) ?? null}
                    {@const state = rowState(axis, i)}
                    <RatingTestRow
                        {axis}
                        {rating}
                        {state}
                        {blocks}
                        open={isRowOpen(axis)}
                        onToggle={() => toggleRow(axis)}
                        {onJump}
                        bind:triggerRef={rowRefs[axis]}
                    />
                {/if}
            {/each}
        </ul>

        <RatingSummaryFooter {counts} {totalElapsedMs} {allPassed} />
    </section>
{/if}

<style>
    .ratings-panel {
        /* Scoped tokens — reused by nested ratings-panel components. */
        --row-height: 36px;
        --gutter-w: 2px;
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
        /* Container-query context for nested narrow-width behavior. */
        container-type: inline-size;
        container-name: ratings;
        /* See IssuesPanel for why width:100% is needed alongside container-type */
        width: 100%;
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

    .rating-rows {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
    }

    /* Faint 1px separator between adjacent rows — a structured cadence that
       tracks row height even when rows expand. Uses :global() because the
       .row class lives inside the RatingTestRow child component. */
    .rating-rows :global(.row + .row) {
        border-top: 1px solid var(--grid-line);
    }

    /* Summary footer styles live in RatingSummaryFooter.svelte — extracted so
       the grid view and the list view can share the same chrome without
       drift. */
</style>
