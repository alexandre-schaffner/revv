<script lang="ts">
/*
 * File and step links live in the expanded body so the row has no nested
 * click targets.
 */
import {
  ISSUE_SEVERITY_LABEL,
  issueResolutionLabel,
  type WalkthroughBlock,
  type WalkthroughIssue,
} from "@revv/shared";
import Check from "phosphor-svelte/lib/Check";
import { Checkbox } from "$lib/components/ui/checkbox";
import { enterOnce } from "$lib/motion";
import IssueExpandedBody from "./IssueExpandedBody.svelte";
import SpecRow from "./SpecRow.svelte";

interface Props {
  issue: WalkthroughIssue;
  /** Ticked for the next submit. */
  selected: boolean;
  /** Already posted to GitHub. */
  submitted: boolean;
  open: boolean;
  /** Rows sharing a group cascade in together. */
  cascadeGroup: string;
  onToggleSelect: () => void;
  onToggleOpen: () => void;
  onFileClick?: ((filePath: string, line: number) => void) | undefined;
  onTriggerRef?: ((el: HTMLElement | null) => void) | undefined;
  blocks: WalkthroughBlock[];
  onBlockJump?: ((blockId: string) => void) | undefined;
}

let {
  issue,
  selected,
  submitted,
  open,
  cascadeGroup,
  onToggleSelect,
  onToggleOpen,
  onFileClick,
  onTriggerRef,
  blocks,
  onBlockJump,
}: Props = $props();

/** Compiler-style prefix (like TS2345's leading letter), tabular so rows line up. */
const severityCode: Record<WalkthroughIssue["severity"], string> = {
  critical: "E",
  warning: "W",
  info: "I",
};

const resolutionLabel = $derived(issueResolutionLabel(issue.resolutionStatus));
const resolved = $derived(resolutionLabel !== null);

const ariaLabel = $derived(
  `${ISSUE_SEVERITY_LABEL[issue.severity]}: ${issue.title}${submitted ? " (posted)" : ""}${resolutionLabel ? ` (${resolutionLabel})` : ""}`,
);

const motionKey = $derived(`spec-row:issue:${issue.id}`);

function handleCheckedChange(): void {
  if (submitted || resolved) return;
  onToggleSelect();
}

function stopPropagation(e: MouseEvent): void {
  e.stopPropagation();
}
</script>

<div
    class="issue-row"
    data-severity={issue.severity}
    class:issue-row--submitted={submitted}
    class:issue-row--resolved={resolved}
    class:issue-row--selected={selected}
    data-open={open ? "true" : undefined}
    use:enterOnce={{
        key: motionKey,
        look: "row",
        cascade: { group: cascadeGroup, step: 0.05, cap: 6 },
    }}
>
    <SpecRow
        {open}
        onToggle={onToggleOpen}
        {motionKey}
        {submitted}
        {ariaLabel}
        {onTriggerRef}
    >
        {#snippet icon()}
            {#if submitted || resolved}
                <span class="staged-check" aria-hidden="true">
                    <Check size={13} />
                </span>
            {:else}
                <Checkbox
                    checked={selected}
                    aria-label="Include in submit"
                    onCheckedChange={handleCheckedChange}
                    onclick={stopPropagation}
                />
            {/if}
        {/snippet}

        {#snippet label()}
            <span
                class="severity-code"
                title={ISSUE_SEVERITY_LABEL[issue.severity]}
            >
                {severityCode[issue.severity]}
            </span>
            <span class="issue-title">{issue.title}</span>
            {#if resolutionLabel}
                <span class="resolution-badge">{resolutionLabel}</span>
            {/if}
        {/snippet}

        {#snippet preview()}
            <span class="issue-preview">{issue.description}</span>
        {/snippet}

        {#snippet content()}
            <IssueExpandedBody {issue} {blocks} {onFileClick} {onBlockJump} />
        {/snippet}
    </SpecRow>
</div>

<style>
    /* The scorecard's palette, so an issue gutter matches a concern /
       blocker cell. */
    .issue-row {
        --c-gutter-color: var(--severity-score-icon);
        --c-row-bg: var(--severity-score-bg);
        --c-gutter-flash: color-mix(in srgb, var(--severity-score-icon) 70%, white);
    }
    .issue-row--resolved {
        --c-gutter-color: var(--color-success);
        --c-row-bg: color-mix(in srgb, var(--color-success) 7%, var(--color-bg-elevated));
    }

    .issue-row--selected:not(.issue-row--submitted) {
        background: color-mix(in srgb, var(--c-gutter-color) 6%, transparent);
    }

    .issue-row[data-open="true"] :global(.spec-row-trigger:not(:disabled):not([aria-disabled="true"])) {
        background: color-mix(
            in srgb,
            var(--c-gutter-color) 8%,
            transparent
        );
    }

    .staged-check {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--color-success);
    }

    .severity-code {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-family: var(--font-mono);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 1px 5px;
        border-radius: 3px;
        min-width: 2ch;
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
        color: var(--severity-score-label);
        background: color-mix(in srgb, var(--severity-score-bg) 85%, transparent);
        border: 1px solid color-mix(in srgb, var(--severity-score-border) 35%, transparent);
    }

    .issue-title {
        font-family: var(--font-sans);
        font-size: 13px;
        font-weight: 500;
        color: var(--color-text-secondary);
        letter-spacing: -0.005em;
        line-height: 1.3;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
    }

    .resolution-badge {
        flex-shrink: 0;
        border: 1px solid color-mix(in srgb, var(--color-success) 35%, transparent);
        border-radius: 9999px;
        padding: 1px 6px;
        color: var(--color-success);
        font-family: var(--font-mono);
        font-size: 9.5px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
    }

    .issue-preview {
        font-family: var(--font-sans);
        font-size: 12px;
        color: var(--color-text-muted);
        white-space: nowrap;
        min-width: 0;
    }
</style>
