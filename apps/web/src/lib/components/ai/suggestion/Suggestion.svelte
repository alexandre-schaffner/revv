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
	role="group"
	aria-label="Suggestions"
	class={cn("flex w-full flex-wrap items-center gap-2", className)}
	{...restProps}
>
	{@render children?.()}
</div>
