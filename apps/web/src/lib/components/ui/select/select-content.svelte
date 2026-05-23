<script lang="ts">
import { Select as SelectPrimitive } from "bits-ui";
import type { Snippet } from "svelte";
import { bitsAnim, popoverPopIn, popoverPopOut } from "$lib/motion";
import type { WithoutChildrenOrChild } from "$lib/utils.js";
import { cn } from "$lib/utils.js";

let {
  ref = $bindable(null),
  class: className,
  sideOffset = 4,
  children,
  ...restProps
}: WithoutChildrenOrChild<SelectPrimitive.ContentProps> & {
  children?: Snippet;
} = $props();
</script>

<SelectPrimitive.Portal>
	<SelectPrimitive.Content {sideOffset} {...restProps}>
		{#snippet child({ props })}
			<div
				bind:this={ref}
				{...props}
				data-slot="select-content"
				class={cn(
					"relative z-50 min-w-[8rem] overflow-hidden rounded-md border border-border shadow-md",
					className
				)}
				use:bitsAnim={{
					inPreset: popoverPopIn,
					outPreset: popoverPopOut,
					directionAware: true,
				}}
			>
				<SelectPrimitive.Viewport class="p-1">
					{@render children?.()}
				</SelectPrimitive.Viewport>
			</div>
		{/snippet}
	</SelectPrimitive.Content>
</SelectPrimitive.Portal>

<style>
	:global([data-slot="select-content"]) {
		background: var(--color-glass-bg);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--color-glass-border);
		box-shadow: var(--color-shadow-lg);
	}
</style>
