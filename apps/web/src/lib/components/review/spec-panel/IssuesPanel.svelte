<script lang="ts">
/*
 * The walkthrough's issues as a lint-diagnostics panel: one flat list sorted
 * critical → warning → info. `x` toggles the focused row's selection.
 */
import { isIssueResolved, type WalkthroughBlock, type WalkthroughIssue } from "@revv/shared";
import CheckSquare from "phosphor-svelte/lib/CheckSquare";
import Circle from "phosphor-svelte/lib/Circle";
import Square from "phosphor-svelte/lib/Square";
import Warning from "phosphor-svelte/lib/Warning";
import WarningOctagon from "phosphor-svelte/lib/WarningOctagon";
import LowSignalDisclosure from "$lib/components/walkthrough/LowSignalDisclosure.svelte";
import { countBySeverity, sortBySeverity } from "$lib/utils/walkthrough-issues";
import { createExpandState } from "./expand-state.svelte";
import IssueRow from "./IssueRow.svelte";
import { createRowKeys } from "./row-keys";
import SpecCount from "./SpecCount.svelte";
import SpecEmpty from "./SpecEmpty.svelte";
import SpecPanel from "./SpecPanel.svelte";
import SpecSummaryBar from "./SpecSummaryBar.svelte";

interface Props {
  issues: readonly WalkthroughIssue[];
  /** Issues rated low signal. Read-only, behind a disclosure, outside the selection model — select-all must never post something the reader didn't see. */
  filteredIssues?: readonly WalkthroughIssue[];
  /** Selected for submit. Owned by YourReview so it survives remounts and PR switches. */
  selectedIds: Set<string>;
  /** Already posted. Owned by YourReview, like `selectedIds`. */
  submittedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onFileClick: (filePath: string, line: number) => void;
  blocks: WalkthroughBlock[];
  onBlockJump: (blockId: string) => void;
}

let {
  issues,
  filteredIssues = [],
  selectedIds,
  submittedIds,
  onToggleSelect,
  onToggleSelectAll,
  onFileClick,
  blocks,
  onBlockJump,
}: Props = $props();

const sortedIssues = $derived(sortBySeverity(issues));

function isSelectable(issue: WalkthroughIssue): boolean {
  return !isIssueResolved(issue) && !submittedIds.has(issue.id);
}

const tally = $derived.by(() => {
  let selected = 0;
  let submittable = 0;
  for (const issue of issues) {
    if (!isIssueResolved(issue) && selectedIds.has(issue.id)) selected++;
    if (isSelectable(issue)) submittable++;
  }
  return { ...countBySeverity(issues), selected, submittable };
});

const allSelected = $derived(
  tally.submittable > 0 && issues.every((i) => !isSelectable(i) || selectedIds.has(i.id)),
);

const expand = createExpandState(() => issues.map((i) => i.id), null);

let onlyCritical = $state(false);
let onlyUnselected = $state(false);

const visibleIssues = $derived.by(() => {
  let list = sortedIssues;
  if (onlyCritical) list = list.filter((i) => i.severity === "critical");
  if (onlyUnselected) list = list.filter((i) => isSelectable(i) && !selectedIds.has(i.id));
  return list;
});

const keys = createRowKeys({
  order: () => visibleIssues.filter(isSelectable).map((i) => i.id),
  toggleAll: () => expand.toggleAll(),
  rowKeys: { x: (id) => onToggleSelect(id) },
});
</script>

{#if issues.length > 0 || filteredIssues.length > 0}
    <SpecPanel label="Walkthrough issues" onkeydown={keys.onkeydown}>
        <SpecSummaryBar
            title="Issues"
            expand={{ all: expand.all, onToggle: () => expand.toggleAll() }}
            filters={[
                {
                    label: "Only critical",
                    active: onlyCritical,
                    onToggle: () => (onlyCritical = !onlyCritical),
                },
                {
                    label: "Only unselected",
                    active: onlyUnselected,
                    onToggle: () => (onlyUnselected = !onlyUnselected),
                },
            ]}
            action={tally.submittable > 0
                ? {
                      label: allSelected ? "Clear" : "Select all",
                      icon: allSelected ? Square : CheckSquare,
                      onclick: onToggleSelectAll,
                  }
                : undefined}
        >
            {#snippet icon()}<Warning size={14} weight="fill" />{/snippet}
            {#snippet counts()}
                <SpecCount tone="blocker" count={tally.critical} label="critical">
                    <WarningOctagon size={11} weight="fill" />
                </SpecCount>
                <SpecCount
                    tone="concern"
                    count={tally.warning}
                    label={tally.warning === 1 ? "warning" : "warnings"}
                >
                    <Warning size={11} weight="fill" />
                </SpecCount>
                <SpecCount tone="info" count={tally.info} label="info">
                    <Circle size={11} />
                </SpecCount>
                {#if tally.submittable > 0}
                    <span class="count-divider" aria-hidden="true">│</span>
                    <SpecCount
                        tone="accent"
                        count={tally.selected}
                        label="selected"
                        title="{tally.selected} selected for submit"
                    />
                {/if}
            {/snippet}
        </SpecSummaryBar>

        {#if visibleIssues.length === 0}
            <SpecEmpty>
                {#if onlyCritical && onlyUnselected}
                    no unselected critical issues — filter hides everything else
                {:else if onlyCritical}
                    no critical issues
                {:else if onlyUnselected}
                    every issue is already selected or posted
                {/if}
            </SpecEmpty>
        {:else}
            <div class="issue-rows" role="list">
                {#each visibleIssues as issue (issue.id)}
                    <IssueRow
                        {issue}
                        selected={selectedIds.has(issue.id) && !isIssueResolved(issue)}
                        submitted={submittedIds.has(issue.id)}
                        open={expand.isOpen(issue.id)}
                        cascadeGroup="issue-rows"
                        onToggleSelect={() => onToggleSelect(issue.id)}
                        onToggleOpen={() => expand.toggle(issue.id)}
                        {onFileClick}
                        {blocks}
                        {onBlockJump}
                        onTriggerRef={keys.trigger(issue.id)}
                    />
                {/each}
            </div>
        {/if}

        {#if filteredIssues.length > 0}
            <div class="low-signal-slot">
                <LowSignalDisclosure count={filteredIssues.length}>
                    <div class="issue-rows" role="list">
                        {#each filteredIssues as issue (issue.id)}
                            <IssueRow
                                {issue}
                                selected={false}
                                submitted={true}
                                open={expand.isOpen(issue.id)}
                                cascadeGroup="low-signal-issue-rows"
                                onToggleSelect={() => {}}
                                onToggleOpen={() => expand.toggle(issue.id)}
                                {onFileClick}
                                {blocks}
                                {onBlockJump}
                            />
                        {/each}
                    </div>
                </LowSignalDisclosure>
            </div>
        {/if}
    </SpecPanel>
{:else}
    <SpecPanel label="Walkthrough issues" empty="no issues flagged by walkthrough" />
{/if}

<style>
    .count-divider {
        font-family: var(--font-mono);
        font-size: 12px;
        color: var(--color-text-muted);
        opacity: 0.4;
    }

    .low-signal-slot {
        border-top: 1px solid var(--color-border);
        padding: 4px 6px 6px;
    }

    .issue-rows {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
    }

    .issue-rows :global(.issue-row + .issue-row) {
        border-top: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
    }
</style>
