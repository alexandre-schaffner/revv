<script lang="ts">
import { Tooltip as TooltipPrimitive } from "bits-ui";
import type { ComponentProps, Snippet } from "svelte";
import { bitsAnim, tooltipPopIn, tooltipPopOut } from "$lib/motion";
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
}: WithoutChildrenOrChild<TooltipPrimitive.ContentProps> & {
  portalProps?: WithoutChildrenOrChild<ComponentProps<typeof TooltipPortal>>;
  children?: Snippet;
} = $props();
</script>

<TooltipPortal {...portalProps}>
	<TooltipPrimitive.Content {sideOffset} {side} {...restProps}>
		{#snippet child({ props, wrapperProps })}
			<!-- See popover-content.svelte for why wrapperProps + props are both required. -->
			<div {...wrapperProps}>
				<div
					bind:this={ref}
					{...props}
					data-slot="tooltip-content"
					class={cn(
						"inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm text-popover-foreground z-50 w-fit max-w-xs origin-(--bits-tooltip-content-transform-origin)",
						className
					)}
					use:bitsAnim={{
						inPreset: tooltipPopIn,
						outPreset: tooltipPopOut,
						directionAware: true,
					}}
				>
					{@render children?.()}
				</div>
			</div>
		{/snippet}
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
</style>
