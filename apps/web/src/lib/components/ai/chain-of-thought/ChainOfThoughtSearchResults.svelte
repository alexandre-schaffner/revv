<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";

	export type ChainOfThoughtSearchResultsProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: ChainOfThoughtSearchResultsProps = $props();
</script>

<div
	data-slot="chain-of-thought-search-results"
	class={cn("mt-1 flex flex-wrap gap-1", className)}
	{...restProps}
>
	{@render children?.()}
</div>
