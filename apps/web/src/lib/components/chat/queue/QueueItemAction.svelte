<script lang="ts">
// Icon button on a queue row; hidden until the row is hovered unless the
// caller makes it always visible.
import { Button, type ButtonProps } from "$lib/components/ui/button/index.js";
import { cn } from "$lib/utils.js";

let { children, class: className, ...restProps }: Omit<ButtonProps, "variant" | "size"> = $props();
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
