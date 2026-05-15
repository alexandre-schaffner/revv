<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";

	export type SuggestionProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: SuggestionProps = $props();
</script>

<div
	data-slot="suggestion"
	class={cn("flex flex-wrap gap-2", className)}
	role="group"
	aria-label="Suggestions"
	{...restProps}
>
	{@render children?.()}
</div>
