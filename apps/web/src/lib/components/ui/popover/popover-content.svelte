<script lang="ts">
import { Popover as PopoverPrimitive } from "bits-ui";
import type { ComponentProps, Snippet } from "svelte";
import { bitsAnim, popoverPopIn, popoverPopOut } from "$lib/motion";
import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
import PopoverPortal from "./popover-portal.svelte";

let {
  ref = $bindable(null),
  class: className,
  sideOffset = 6,
  align = "center",
  portalProps,
  children,
  ...restProps
}: WithoutChildrenOrChild<PopoverPrimitive.ContentProps> & {
  portalProps?: WithoutChildrenOrChild<ComponentProps<typeof PopoverPortal>>;
  children?: Snippet;
} = $props();
</script>

<PopoverPortal {...portalProps}>
	<PopoverPrimitive.Content {sideOffset} {align} {...restProps}>
		{#snippet child({ props })}
			<div
				bind:this={ref}
				{...props}
				data-slot="popover-content"
				class={cn(
					"text-text-primary flex flex-col gap-2.5 rounded-xl p-3 text-sm z-50 w-72 origin-(--transform-origin) outline-hidden",
					className
				)}
				use:bitsAnim={{
					inPreset: popoverPopIn,
					outPreset: popoverPopOut,
					directionAware: true,
				}}
			>
				{@render children?.()}
			</div>
		{/snippet}
	</PopoverPrimitive.Content>
</PopoverPortal>

<style>
	:global([data-slot="popover-content"]) {
		background: var(--color-glass-bg);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--color-glass-border);
		box-shadow: var(--color-shadow-lg);
		scrollbar-width: none; /* Firefox */
	}

	:global([data-slot="popover-content"]::-webkit-scrollbar) {
		display: none; /* Chrome/Safari */
	}

	:global([data-slot="popover-content"] *) {
		scrollbar-width: none;
	}

	:global([data-slot="popover-content"] *::-webkit-scrollbar) {
		display: none;
	}
</style>
