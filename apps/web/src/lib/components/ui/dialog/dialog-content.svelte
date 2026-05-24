<script lang="ts">
import { Dialog as DialogPrimitive } from "bits-ui";
import XIcon from "phosphor-svelte/lib/X";
import type { ComponentProps, Snippet } from "svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { bitsAnim, dialogSpringIn, dialogSpringOut } from "$lib/motion";
import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
import DialogPortal from "./dialog-portal.svelte";
import * as Dialog from "./index.js";

let {
  ref = $bindable(null),
  class: className,
  portalProps,
  children,
  showCloseButton = true,
  ...restProps
}: WithoutChildrenOrChild<DialogPrimitive.ContentProps> & {
  portalProps?: WithoutChildrenOrChild<ComponentProps<typeof DialogPortal>>;
  children: Snippet;
  showCloseButton?: boolean;
} = $props();
</script>

<DialogPortal {...portalProps}>
	<Dialog.Overlay />
	<DialogPrimitive.Content {...restProps}>
		{#snippet child({ props })}
			<div
				bind:this={ref}
				{...props}
				data-slot="dialog-content"
				class={cn(
					"text-popover-foreground grid max-w-[calc(100%-2rem)] gap-4 rounded-xl p-6 text-sm sm:max-w-sm fixed top-[20%] inset-x-0 mx-auto z-50 w-full outline-none",
					className
				)}
				use:bitsAnim={{ inPreset: dialogSpringIn, outPreset: dialogSpringOut }}
			>
				{@render children?.()}
				{#if showCloseButton}
					<DialogPrimitive.Close data-slot="dialog-close">
						{#snippet child({ props: closeProps })}
							<Button variant="ghost" class="absolute top-3 right-3" size="icon-sm" {...closeProps}>
								<XIcon />
								<span class="sr-only">Close</span>
							</Button>
						{/snippet}
					</DialogPrimitive.Close>
				{/if}
			</div>
		{/snippet}
	</DialogPrimitive.Content>
</DialogPortal>

<style>
	:global([data-slot="dialog-content"]) {
		background: var(--color-glass-bg);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--color-glass-border);
	}
</style>
