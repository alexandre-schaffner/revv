<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type SuggestionProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { ScrollArea, ScrollAreaScrollbar } from "$lib/components/ui/scroll-area/index.js";

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
	{...restProps}
>
	<ScrollArea class="w-full overflow-x-auto whitespace-nowrap">
		<div class={cn("flex w-max flex-nowrap items-center gap-2", className)}>
			{@render children?.()}
		</div>
		<ScrollAreaScrollbar class="hidden" orientation="horizontal" />
	</ScrollArea>
</div>
