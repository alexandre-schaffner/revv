<script lang="ts" module>
import type { ButtonProps } from "$lib/components/ui/button/index.js";

export type QueueItemActionProps = Omit<ButtonProps, "variant" | "size">;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { Button } from "$lib/components/ui/button/index.js";

	let {
		children,
		class: className,
		...restProps
	}: QueueItemActionProps = $props();
</script>

<Button
	data-slot="queue-item-action"
	variant="ghost"
	size="icon"
	class={cn(
		"size-auto rounded p-1 text-muted-foreground opacity-0 transition-opacity duration-snap hover:bg-muted-foreground/10 hover:text-foreground group-hover:opacity-100",
		className,
	)}
	type="button"
	{...restProps}
>
	{@render children?.()}
</Button>
