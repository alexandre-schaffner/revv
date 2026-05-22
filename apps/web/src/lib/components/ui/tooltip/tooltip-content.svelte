<script lang="ts">
import { Tooltip as TooltipPrimitive } from "bits-ui";
import type { ComponentProps } from "svelte";
import type { WithoutChildrenOrChild } from "$lib/utils.js";
import { cn } from "$lib/utils.js";
import TooltipPortal from "./tooltip-portal.svelte";

let {
  ref = $bindable(null),
  class: className,
  sideOffset = 8,
  side = "top",
  children,
  portalProps,
  ...restProps
}: TooltipPrimitive.ContentProps & {
  portalProps?: WithoutChildrenOrChild<ComponentProps<typeof TooltipPortal>>;
} = $props();
</script>

<TooltipPortal {...portalProps}>
	<TooltipPrimitive.Content
		bind:ref
		data-slot="tooltip-content"
		{sideOffset}
		{side}
		class={cn(
			"inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm text-popover-foreground z-50 w-fit max-w-xs origin-(--bits-tooltip-content-transform-origin)",
			className
		)}
		{...restProps}
	>
		{@render children?.()}
	</TooltipPrimitive.Content>
</TooltipPortal>

<style>
	:global([data-slot="tooltip-content"]) {
		background: var(--color-glass-bg);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--color-glass-border);
		box-shadow: var(--color-shadow-md);
	}

	@keyframes -global-tooltip-in-right  { from { opacity: 0; scale: 0.95; translate: -4px 0   } to { opacity: 1; scale: 1; translate: 0 0 } }
	@keyframes -global-tooltip-in-left   { from { opacity: 0; scale: 0.95; translate:  4px 0   } to { opacity: 1; scale: 1; translate: 0 0 } }
	@keyframes -global-tooltip-in-top    { from { opacity: 0; scale: 0.95; translate: 0  4px  } to { opacity: 1; scale: 1; translate: 0 0 } }
	@keyframes -global-tooltip-in-bottom { from { opacity: 0; scale: 0.95; translate: 0 -4px  } to { opacity: 1; scale: 1; translate: 0 0 } }

	:global([data-slot="tooltip-content"][data-state="delayed-open"][data-side="right"]),
	:global([data-slot="tooltip-content"][data-state="instant-open"][data-side="right"]) {
		animation: tooltip-in-right var(--duration-quick) var(--ease-out-expo) both;
	}
	:global([data-slot="tooltip-content"][data-state="delayed-open"][data-side="left"]),
	:global([data-slot="tooltip-content"][data-state="instant-open"][data-side="left"]) {
		animation: tooltip-in-left var(--duration-quick) var(--ease-out-expo) both;
	}
	:global([data-slot="tooltip-content"][data-state="delayed-open"][data-side="top"]),
	:global([data-slot="tooltip-content"][data-state="instant-open"][data-side="top"]) {
		animation: tooltip-in-top var(--duration-quick) var(--ease-out-expo) both;
	}
	:global([data-slot="tooltip-content"][data-state="delayed-open"][data-side="bottom"]),
	:global([data-slot="tooltip-content"][data-state="instant-open"][data-side="bottom"]) {
		animation: tooltip-in-bottom var(--duration-quick) var(--ease-out-expo) both;
	}

	@keyframes -global-tooltip-out {
		0% { opacity: 1; scale: 1; }
		100% { opacity: 0; scale: 0.95; }
	}

	:global([data-slot="tooltip-content"][data-state="closed"]) {
		animation: tooltip-out var(--duration-snap) var(--ease-soft) both;
	}
</style>
