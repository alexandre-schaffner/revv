<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type ConversationContentProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: ConversationContentProps = $props();
</script>

<div
	data-slot="conversation-content"
	class={cn("flex flex-col gap-4 px-4 py-4", className)}
	role="log"
	aria-live="polite"
	{...restProps}
>
	{@render children?.()}
</div>
