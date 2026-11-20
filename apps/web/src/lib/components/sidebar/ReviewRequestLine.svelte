<script lang="ts">
import UserFocus from "phosphor-svelte/lib/UserFocus";
import { type RequestReason, reasonText } from "$lib/conversation/codeowners-review";

// Why the viewer is asked to review this PR, in one quiet line under the file
// search: the CODEOWNERS rule (or the person) that asked, and how many of the
// changed files the owner scope covers.

interface Props {
  reason: RequestReason;
  /** Changed files in the owner scope; 0 hides the count. */
  scopedCount: number;
  totalFiles: number;
}

let { reason, scopedCount, totalFiles }: Props = $props();

const text = $derived(reasonText(reason));
const share = $derived(
  `${scopedCount} of ${totalFiles} ${totalFiles === 1 ? "file" : "files"} in your scope`,
);
</script>

<p class="rr-line" title={scopedCount > 0 ? `${text}\n${share}` : text}>
	<UserFocus size={12} class="rr-icon" aria-hidden="true" />
	<span class="rr-reason">{text}</span>
	{#if scopedCount > 0}
		<span class="rr-share" aria-label={share}>{scopedCount}/{totalFiles}</span>
	{/if}
</p>

<style>
	.rr-line {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		margin: 0;
		padding: 0 14px 6px;
		font-size: 0.75rem;
		font-weight: 500;
		letter-spacing: 0.01em;
		color: var(--color-text-secondary);
	}

	.rr-line :global(.rr-icon) {
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	.rr-reason {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.rr-share {
		flex-shrink: 0;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}
</style>
