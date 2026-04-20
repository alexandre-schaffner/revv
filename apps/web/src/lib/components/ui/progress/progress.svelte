<script lang="ts">
	import { cn } from '$lib/utils.js';

	let {
		class: className,
		value,
		max = 100,
		indeterminate = false,
	}: { class?: string; value?: number; max?: number; indeterminate?: boolean } = $props();
</script>

<div
	class={cn('relative h-2 w-full overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]', className)}
	role="progressbar"
	aria-valuenow={indeterminate ? undefined : value}
	aria-valuemax={max}
>
	{#if indeterminate}
		<div class="absolute h-full w-1/3 rounded-full bg-[var(--color-accent)] animate-indeterminate-progress"></div>
	{:else}
		<div
			class="h-full bg-[var(--color-accent)] transition-all"
			style="width: {(((value ?? 0) / (max ?? 100)) * 100)}%"
		></div>
	{/if}
</div>
