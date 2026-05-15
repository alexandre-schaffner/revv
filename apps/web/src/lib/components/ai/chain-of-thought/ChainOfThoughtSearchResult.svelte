<script lang="ts" module>
	export type ChainOfThoughtSearchResultProps = {
		class?: string;
	};
</script>

<script lang="ts">
	import type { Snippet } from "svelte";
	import { cn } from "$lib/utils.js";
	import { Badge } from "$lib/components/ui/badge/index.js";

	let {
		children,
		class: className,
	}: ChainOfThoughtSearchResultProps & { children?: Snippet } = $props();
</script>

<Badge
	data-slot="chain-of-thought-search-result"
	variant="secondary"
	class={cn("text-[10px] font-normal", className)}
>
	{@render children?.()}
</Badge>
