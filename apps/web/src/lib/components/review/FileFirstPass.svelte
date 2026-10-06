<script lang="ts">
import { flaggedHunkSmells } from "@revv/shared";
import HunkSmellChip from "$lib/components/walkthrough/first-pass/HunkSmellChip.svelte";
import { getHunkScanForFile } from "$lib/stores/hunk-scan.svelte";
import { getLoadedHeadSha, jumpToDiffLine } from "$lib/stores/review.svelte";
import {
  getIsStreaming,
  getIssuesForFile,
  getLeads,
  getReviewsLoadedHead,
} from "$lib/stores/walkthrough.svelte";
import { hunkRangeLabel, leadOutcome, patchHunkRanges, rowMatchesHunk } from "$lib/utils/hunk-scan";

/**
 * The first pass's flagged hunks for one file, as a strip of jump targets
 * above its diff. Shown from the moment the scan answers, walkthrough or not;
 * once a review of this head exists, each chip also says what it made of the lead.
 * A row only shows when its range matches the hunk the patch has at its index,
 * so a scan of another diff never labels the wrong lines.
 */
interface Props {
  prId: string;
  filePath: string;
  /** The file's patch as the diff below renders it; null for binary files. */
  patch: string | null;
}

let { prId, filePath, patch }: Props = $props();

const hunkRanges = $derived(patch === null ? [] : patchHunkRanges(patch));

const reviewed = $derived(getReviewsLoadedHead());

const hunks = $derived.by(() => {
  const issues = getIssuesForFile(filePath);
  const isComplete = !getIsStreaming();
  const leads = getLeads();
  return getHunkScanForFile(prId, getLoadedHeadSha(prId), filePath)
    .filter((row) => {
      const hunk = hunkRanges[row.hunkIndex];
      return hunk !== undefined && rowMatchesHunk(row, hunk);
    })
    .map((row) => ({ row, smells: flaggedHunkSmells(row.signals) }))
    .filter(({ smells }) => smells.length > 0)
    .sort((a, b) => a.row.newStart - b.row.newStart)
    .map(({ row, smells }) => ({
      row,
      smells,
      outcome: reviewed ? leadOutcome(row, issues, isComplete, leads) : undefined,
    }));
});
</script>

{#if hunks.length > 0}
	<div class="file-first-pass">
		<span class="file-first-pass-label">First pass</span>
		<div class="file-first-pass-strip">
			{#each hunks as { row, smells, outcome } (row.hunkIndex)}
				<button
					type="button"
					class="file-first-pass-hunk"
					title="Jump to {hunkRangeLabel(row)}"
					onclick={() => jumpToDiffLine(row.filePath, row.newStart)}
				>
					<span class="file-first-pass-range">{hunkRangeLabel(row)}</span>
					{#each smells as { smell, probability } (smell)}
						<HunkSmellChip {smell} {probability} {outcome} />
					{/each}
				</button>
			{/each}
		</div>
	</div>
{/if}

<style>
	.file-first-pass {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 0 32px 16px;
	}

	.file-first-pass-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.file-first-pass-strip {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 10px;
		/* Optical: the flat button's padding, so the first range sits on the label's edge. */
		margin-left: -6px;
	}

	/* Flat until hovered: the chips are the pills, the range just leads them. */
	.file-first-pass-hunk {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 4px 2px 6px;
		border: none;
		border-radius: 999px;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	.file-first-pass-hunk:hover {
		background: var(--color-bg-tertiary);
	}

	.file-first-pass-hunk:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
	}

	.file-first-pass-range {
		margin-right: 2px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-accent);
	}
</style>
