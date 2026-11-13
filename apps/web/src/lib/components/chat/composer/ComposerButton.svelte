<script lang="ts">
import { Button, type ButtonProps } from "$lib/components/ui/button/index.js";
import * as Tooltip from "$lib/components/ui/tooltip/index.js";
import { cn } from "$lib/utils.js";

let {
  tooltip,
  children,
  class: className,
  ...restProps
}: ButtonProps & { tooltip: string } = $props();
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		<Button
			data-slot="prompt-input-button"
			variant="ghost"
			size="sm"
			class={cn("gap-1.5 text-muted-foreground", className)}
			type="button"
			{...restProps}
		>
			{@render children?.()}
		</Button>
	</Tooltip.Trigger>
	<Tooltip.Content>
		<span>{tooltip}</span>
	</Tooltip.Content>
</Tooltip.Root>
