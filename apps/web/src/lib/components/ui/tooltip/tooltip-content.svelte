<script lang="ts">
	import { Tooltip as TooltipPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";
	import TooltipPortal from "./tooltip-portal.svelte";
	import type { ComponentProps } from "svelte";
	import type { WithoutChildrenOrChild } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		sideOffset = 10,
		side = "top",
		children,
		arrowClasses,
		portalProps,
		...restProps
	}: TooltipPrimitive.ContentProps & {
		arrowClasses?: string;
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
		<TooltipPrimitive.Arrow>
			{#snippet child({ props })}
				<div class="tooltip-arrow" {...props}></div>
			{/snippet}
		</TooltipPrimitive.Arrow>
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

	:global(.tooltip-arrow) {
		width: 10px;
		height: 6px;
		background: var(--color-glass-bg);
		filter: drop-shadow(0 0 0.5px var(--color-glass-border));
	}

	/* Arrow shape per side — clip-path draws a triangle pointing toward the trigger */
	:global([data-side="top"] .tooltip-arrow) {
		clip-path: polygon(0 0, 100% 0, 50% 100%); /* points down */
		width: 10px;
		height: 6px;
	}
	:global([data-side="bottom"] .tooltip-arrow) {
		clip-path: polygon(50% 0, 100% 100%, 0 100%); /* points up */
		width: 10px;
		height: 6px;
	}
	:global([data-side="left"] .tooltip-arrow) {
		clip-path: polygon(0 0, 0 100%, 100% 50%); /* points right */
		width: 6px;
		height: 10px;
	}
	:global([data-side="right"] .tooltip-arrow) {
		clip-path: polygon(100% 0, 100% 100%, 0 50%); /* points left */
		width: 6px;
		height: 10px;
	}

	@keyframes -global-tooltip-in-right  { from { opacity: 0; scale: 0.95; translate: -4px 0   } to { opacity: 1; scale: 1; translate: 0 0 } }
	@keyframes -global-tooltip-in-left   { from { opacity: 0; scale: 0.95; translate:  4px 0   } to { opacity: 1; scale: 1; translate: 0 0 } }
	@keyframes -global-tooltip-in-top    { from { opacity: 0; scale: 0.95; translate: 0  4px  } to { opacity: 1; scale: 1; translate: 0 0 } }
	@keyframes -global-tooltip-in-bottom { from { opacity: 0; scale: 0.95; translate: 0 -4px  } to { opacity: 1; scale: 1; translate: 0 0 } }

	:global([data-slot="tooltip-content"][data-state="delayed-open"][data-side="right"]),
	:global([data-slot="tooltip-content"][data-state="instant-open"][data-side="right"]) {
		animation: tooltip-in-right 180ms cubic-bezier(0.16, 1, 0.3, 1) both;
	}
	:global([data-slot="tooltip-content"][data-state="delayed-open"][data-side="left"]),
	:global([data-slot="tooltip-content"][data-state="instant-open"][data-side="left"]) {
		animation: tooltip-in-left 180ms cubic-bezier(0.16, 1, 0.3, 1) both;
	}
	:global([data-slot="tooltip-content"][data-state="delayed-open"][data-side="top"]),
	:global([data-slot="tooltip-content"][data-state="instant-open"][data-side="top"]) {
		animation: tooltip-in-top 180ms cubic-bezier(0.16, 1, 0.3, 1) both;
	}
	:global([data-slot="tooltip-content"][data-state="delayed-open"][data-side="bottom"]),
	:global([data-slot="tooltip-content"][data-state="instant-open"][data-side="bottom"]) {
		animation: tooltip-in-bottom 180ms cubic-bezier(0.16, 1, 0.3, 1) both;
	}

	@keyframes -global-tooltip-out {
		0% { opacity: 1; scale: 1; }
		100% { opacity: 0; scale: 0.95; }
	}

	:global([data-slot="tooltip-content"][data-state="closed"]) {
		animation: tooltip-out 120ms ease-in both;
	}
</style>
