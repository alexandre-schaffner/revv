<script lang="ts">
import type { StackEntryStatus } from "@revv/shared";
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import FileDashed from "phosphor-svelte/lib/FileDashed";
import GitMerge from "phosphor-svelte/lib/GitMerge";
import MinusCircle from "phosphor-svelte/lib/MinusCircle";
import XCircle from "phosphor-svelte/lib/XCircle";

interface Props {
  status: StackEntryStatus;
  size?: number;
}

let { status, size = 14 }: Props = $props();
</script>

<span class="glyph glyph--{status}" style:--glyph-size="{size}px" aria-hidden="true">
	{#if status === 'merged'}
		<GitMerge {size} weight="bold" />
	{:else if status === 'closed'}
		<XCircle {size} />
	{:else if status === 'draft'}
		<FileDashed {size} />
	{:else if status === 'ready'}
		<CheckCircle {size} weight="fill" />
	{:else}
		<MinusCircle {size} weight="fill" />
	{/if}
</span>

<style>
	.glyph {
		display: inline-grid;
		place-items: center;
		flex-shrink: 0;
		width: var(--glyph-size);
		height: var(--glyph-size);
		line-height: 0;
	}

	.glyph--merged {
		color: var(--color-merged);
	}

	.glyph--closed {
		color: var(--color-danger);
	}

	.glyph--draft {
		color: var(--color-text-muted);
	}

	.glyph--ready {
		color: var(--color-success);
	}

	.glyph--not_ready {
		color: var(--color-warning);
	}
</style>
