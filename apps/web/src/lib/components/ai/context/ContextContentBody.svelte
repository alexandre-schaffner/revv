<script lang="ts" module>
	import type { Snippet } from 'svelte';

	export type ContextContentBodyProps = {
		class?: string;
		children?: Snippet;
	};
</script>

<script lang="ts">
	import { cn } from '$lib/utils.js';

	let { class: className, children }: ContextContentBodyProps = $props();
</script>

<div class={cn('flex w-full flex-col gap-1.5 p-3', className)}>
	{@render children?.()}
</div>
