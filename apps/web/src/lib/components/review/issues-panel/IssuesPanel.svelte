<script lang="ts">
    /*
     * IssuesPanel — orchestrates a list of walkthrough issues in the Request
     * Changes tab. Styled as a lint-diagnostics panel: one summary bar up
     * top, then a flat list of collapsible rows sorted by severity
     * (critical → warning → info), no grouping headers.
     *
     * Interaction model mirrors WalkthroughRatingsPanel:
     *   - Tri-state `expandAll` (true / false / null) with per-row snapshot
     *     flush on single-row toggle.
     *   - `onlyCritical` filter hides warning + info rows.
     *   - `onlyUnselected` filter hides already-selected rows (signals "what
     *     else should I include?").
     *   - Keyboard: ArrowDown/Up/Home/End navigate the trigger list, `e`
     *     toggles expand-all, `x` toggles selection of the focused row.
     */
    import type { WalkthroughIssue, WalkthroughBlock } from "@revv/shared";
    import { groupIssuesBySeverityWithIndex } from "$lib/utils/walkthrough-issues";
    import IssueSummaryBar from "./IssueSummaryBar.svelte";
    import IssueTestRow from "./IssueTestRow.svelte";
    import FileBadge from "$lib/components/ui/FileBadge.svelte";
    import { ArrowUpRight } from "@lucide/svelte";

    interface Props {
        issues: readonly WalkthroughIssue[];
        /** Selected-for-submit set — lives in RequestChanges so it survives
         *  remounts and persists across PR switches. Passed in so this
         *  panel stays stateless w.r.t. that data. */
        selectedIds: Set<string>;
        /** Already-posted set — ditto. */
        submittedIds: Set<string>;
        onToggleSelect: (id: string) => void;
        onToggleSelectAll: () => void;
        onFileClick: (filePath: string, line: number) => void;
        blocks: WalkthroughBlock[];
        onBlockJump: (blockId: string) => void;
    }

    let {
        issues,
        selectedIds,
        submittedIds,
        onToggleSelect,
        onToggleSelectAll,
        onFileClick,
        blocks,
        onBlockJump,
    }: Props = $props();

    // ── Derived: sorted issue list + counts ──────────────────

    // Flatten the severity-grouped output into a single sorted array.
    // `groupIssuesBySeverityWithIndex` preserves within-group arrival order
    // and sorts groups critical → warning → info, which is exactly the lint
    // convention (errors first).
    const sortedIssues = $derived(
        groupIssuesBySeverityWithIndex(issues).flatMap((g) => g.issues.map((gi) => gi.issue)),
    );

    const counts = $derived.by(() => {
        let critical = 0;
        let warning = 0;
        let info = 0;
        let selected = 0;
        let submittable = 0;
        for (const issue of issues) {
            if (issue.severity === "critical") critical++;
            else if (issue.severity === "warning") warning++;
            else info++;
            if (selectedIds.has(issue.id)) selected++;
            if (!submittedIds.has(issue.id)) submittable++;
        }
        return { critical, warning, info, total: issues.length, selected, submittable };
    });

    const allSelected = $derived(
        counts.submittable > 0 &&
            issues.every((i) => submittedIds.has(i.id) || selectedIds.has(i.id)),
    );

    // ── Expand / collapse state (tri-state) ──────────────────

    let expandAll = $state<boolean | null>(null);
    let rowOpen = $state<Record<string, boolean>>({});

    function isRowOpen(id: string): boolean {
        if (expandAll !== null) return expandAll;
        return rowOpen[id] ?? false;
    }

    function toggleRow(id: string): void {
        // Flush the expand-all snapshot when the user clicks a single row,
        // same pattern as WalkthroughRatingsPanel. Otherwise a single-row
        // toggle after "Expand all" would collapse every OTHER row.
        if (expandAll !== null) {
            const snapshot: Record<string, boolean> = {};
            for (const i of issues) snapshot[i.id] = expandAll;
            snapshot[id] = !expandAll;
            rowOpen = snapshot;
            expandAll = null;
            return;
        }
        rowOpen = { ...rowOpen, [id]: !(rowOpen[id] ?? false) };
    }

    function toggleExpandAll(): void {
        const anyOpen =
            expandAll === true || issues.some((i) => rowOpen[i.id] === true);
        expandAll = anyOpen ? false : true;
        rowOpen = {};
    }

    // ── Filters ──────────────────────────────────────────────

    let onlyCritical = $state(false);
    let onlyUnselected = $state(false);

    function toggleOnlyCritical(): void {
        onlyCritical = !onlyCritical;
    }
    function toggleOnlyUnselected(): void {
        onlyUnselected = !onlyUnselected;
    }

    const visibleIssues = $derived.by(() => {
        let list = sortedIssues;
        if (onlyCritical) {
            list = list.filter((i) => i.severity === "critical");
        }
        if (onlyUnselected) {
            list = list.filter(
                (i) => !selectedIds.has(i.id) && !submittedIds.has(i.id),
            );
        }
        return list;
    });

    // ── DOM measurement for trailing column alignment ────────
    // Derive the widest filename and max step number so we can render
    // hidden measurement elements and read their exact pixel widths.
    const longestFileName = $derived.by(() => {
        let longest = '';
        for (const issue of visibleIssues) {
            if (!issue.filePath) continue;
            const name = issue.filePath.split('/').at(-1) ?? '';
            if (name.length > longest.length) longest = name;
        }
        return longest;
    });

    const maxStepNumber = $derived.by(() => {
        let max = 0;
        for (const issue of visibleIssues) {
            for (const blockId of issue.blockIds) {
                const idx = blocks.findIndex((b) => b.id === blockId);
                if (idx >= 0 && idx + 1 > max) max = idx + 1;
            }
        }
        return max;
    });

    // Bound widths from the hidden measurement elements.
    let measuredFileW = $state(0);
    let measuredStepsW = $state(0);

    // ── Keyboard navigation ──────────────────────────────────

    // Non-reactive ref map — rows push their trigger elements in via a
    // callback prop on mount, null out on unmount. Plain Map because we
    // only read from keyboard handlers (no templating over it).
    const rowRefs = new Map<string, HTMLElement | null>();

    function setRowRef(id: string, el: HTMLElement | null): void {
        if (el) rowRefs.set(id, el);
        else rowRefs.delete(id);
    }

    function focusIssue(id: string): void {
        const el = rowRefs.get(id);
        if (el) el.focus();
    }

    function onPanelKeydown(e: KeyboardEvent): void {
        const target = e.target as HTMLElement | null;
        const inInput =
            target?.tagName === "INPUT" ||
            target?.tagName === "TEXTAREA" ||
            target?.isContentEditable;

        // Checkbox focus shouldn't eat the shortcut keys — but ArrowUp/Down
        // inside a checkbox is weird anyway, so we skip shortcut handling
        // whenever the active element is an input/textarea.
        if (inInput) return;

        if (e.key === "e" && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            toggleExpandAll();
            return;
        }

        // Is focus on one of our row triggers?
        let focusedId: string | undefined;
        for (const [id, el] of rowRefs) {
            if (el === target) {
                focusedId = id;
                break;
            }
        }
        if (focusedId === undefined) return;

        const idx = visibleIssues.findIndex((i) => i.id === focusedId);
        if (idx < 0) return;

        if (e.key === "x" && !e.metaKey && !e.ctrlKey && !e.altKey) {
            // `x` toggles selection for the focused row — mirrors vim-style
            // mark keys. Space already triggers the Collapsible by default,
            // so we avoid hijacking it.
            if (!submittedIds.has(focusedId)) {
                e.preventDefault();
                onToggleSelect(focusedId);
            }
            return;
        }

        if (e.key === "ArrowDown" || e.key === "j") {
            e.preventDefault();
            const next = visibleIssues[Math.min(idx + 1, visibleIssues.length - 1)];
            if (next) focusIssue(next.id);
        } else if (e.key === "ArrowUp" || e.key === "k") {
            e.preventDefault();
            const prev = visibleIssues[Math.max(idx - 1, 0)];
            if (prev) focusIssue(prev.id);
        } else if (e.key === "Home") {
            e.preventDefault();
            const first = visibleIssues[0];
            if (first) focusIssue(first.id);
        } else if (e.key === "End") {
            e.preventDefault();
            const last = visibleIssues[visibleIssues.length - 1];
            if (last) focusIssue(last.id);
        }
    }
</script>

{#if issues.length > 0}
    <!-- Hidden measurement elements — rendered off-screen so the browser
         computes the exact pixel widths of the step chip and FileBadge for
         the widest content in the current visible set. These drive the
         --trailing-steps-w and --trailing-file-w CSS variables so all rows
         align their trailing columns without pixel estimation. -->
    <div class="measure-offscreen" aria-hidden="true">
        {#if longestFileName}
            <span class="measure-file-badge" bind:clientWidth={measuredFileW}>
                <FileBadge filePath={longestFileName} />
            </span>
        {/if}
        {#if maxStepNumber > 0}
            <span class="measure-step-chip" bind:clientWidth={measuredStepsW}>
                <ArrowUpRight size={10} />
                step {maxStepNumber}
            </span>
        {/if}
    </div>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <section
        class="issues-panel"
        aria-label="Walkthrough issues"
        role="group"
        onkeydown={onPanelKeydown}
    >
        <IssueSummaryBar
            {counts}
            {expandAll}
            {onlyCritical}
            {onlyUnselected}
            {allSelected}
            onToggleExpandAll={toggleExpandAll}
            onToggleOnlyCritical={toggleOnlyCritical}
            onToggleOnlyUnselected={toggleOnlyUnselected}
            onToggleSelectAll={onToggleSelectAll}
        />

        {#if visibleIssues.length === 0}
            <div class="empty-state">
                {#if onlyCritical && onlyUnselected}
                    no unselected critical issues — filter hides everything else
                {:else if onlyCritical}
                    no critical issues
                {:else if onlyUnselected}
                    every issue is already selected or posted
                {/if}
            </div>
        {:else}
            <div
                class="issue-rows"
                role="list"
                style:--trailing-file-w="{measuredFileW > 0 ? measuredFileW + 'px' : undefined}"
                style:--trailing-steps-w="{measuredStepsW > 0 ? measuredStepsW + 'px' : undefined}"
            >
                {#each visibleIssues as issue, i (issue.id)}
                    <IssueTestRow
                        {issue}
                        selected={selectedIds.has(issue.id)}
                        submitted={submittedIds.has(issue.id)}
                        open={isRowOpen(issue.id)}
                        index={i}
                        onToggleSelect={() => onToggleSelect(issue.id)}
                        onToggleOpen={() => toggleRow(issue.id)}
                        {onFileClick}
                        {blocks}
                        {onBlockJump}
                        onTriggerRef={(el) => setRowRef(issue.id, el)}
                    />
                {/each}
            </div>
        {/if}
    </section>
{:else}
    <section class="issues-panel issues-panel--empty" aria-label="Walkthrough issues">
        <div class="empty-state empty-state--quiet">no issues flagged by walkthrough</div>
    </section>
{/if}

<style>
    .issues-panel {
        display: flex;
        flex-direction: column;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: 10px;
        overflow: hidden;
        font-family: var(--font-mono);
        container-type: inline-size;
        container-name: issues;
        min-width: 0;
    }

    .issues-panel--empty {
        padding: 10px 12px;
    }

    .issue-rows {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
    }

    /* Faint 1px separator between rows — targets IssueTestRow's outer div. */
    .issue-rows :global(.issue-row + .issue-row) {
        border-top: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
    }
    .empty-state {
        padding: 14px 16px;
        font-family: var(--font-mono);
        font-size: 12px;
        color: var(--color-text-muted);
        font-style: italic;
    }

    .empty-state--quiet {
        padding: 10px 12px;
    }

    /* ── Off-screen measurement container ───────────────────── */
    .measure-offscreen {
        position: absolute;
        visibility: hidden;
        pointer-events: none;
        white-space: nowrap;
        top: 0;
        left: 0;
    }

    /* Match step-chip font exactly so measurement is accurate */
    .measure-step-chip {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 7px;
        border-radius: 9999px;
        border: 1px solid transparent;
        font-family: var(--font-mono);
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.02em;
    }

    /* FileBadge renders its own styles, just needs a flex wrapper */
    .measure-file-badge {
        display: inline-flex;
    }
</style>
