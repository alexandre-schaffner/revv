<script lang="ts" module>
	import type { ButtonProps } from "$lib/components/ui/button/index.js";

	export type MessageActionProps = ButtonProps & {
		/** Accessible label for screen readers. Also used as fallback tooltip text. */
		label: string;
		/** Optional tooltip text shown on hover. */
		tooltip?: string;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import * as Tooltip from "$lib/components/ui/tooltip/index.js";

	let {
		label,
		tooltip,
		children,
		class: className,
		...restProps
	}: MessageActionProps = $props();
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		<Button
			data-slot="message-action"
			variant="ghost"
			size="icon-xs"
			class={cn(
				"text-muted-foreground hover:text-foreground",
				className,
			)}
			aria-label={label}
			{...restProps}
		>
			{@render children?.()}
		</Button>
	</Tooltip.Trigger>
	<Tooltip.Content>
		{tooltip ?? label}
	</Tooltip.Content>
</Tooltip.Root>
