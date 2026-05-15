<script lang="ts" module>
export type QueueListProps = {
  class?: string;
};
</script>

<script lang="ts">
	import type { Snippet } from "svelte";
	import { cn } from "$lib/utils.js";
	import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";

	let {
		children,
		class: className,
	}: QueueListProps & { children?: Snippet } = $props();
</script>

<ScrollArea
	data-slot="queue-list"
	class={cn("mt-2 -mb-1", className)}
>
	<div class="max-h-40 pr-4">
		<ul>
			{@render children?.()}
		</ul>
	</div>
</ScrollArea>
