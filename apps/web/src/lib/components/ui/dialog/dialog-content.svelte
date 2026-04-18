<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import DialogPortal from "./dialog-portal.svelte";
	import type { Snippet } from "svelte";
	import * as Dialog from "./index.js";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
	import type { ComponentProps } from "svelte";
	import { Button } from "$lib/components/ui/button/index.js";
	import XIcon from '@lucide/svelte/icons/x';

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
	<DialogPrimitive.Content
		bind:ref
		data-slot="dialog-content"
		class={cn(
			"text-popover-foreground data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 grid max-w-[calc(100%-2rem)] gap-4 rounded-xl p-6 text-sm duration-150 sm:max-w-sm fixed top-[20%] inset-x-0 mx-auto z-50 w-full outline-none",
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		{#if showCloseButton}
			<DialogPrimitive.Close data-slot="dialog-close">
				{#snippet child({ props })}
					<Button variant="ghost" class="absolute top-3 right-3" size="icon-sm" {...props}>
						<XIcon  />
						<span class="sr-only">Close</span>
					</Button>
				{/snippet}
			</DialogPrimitive.Close>
		{/if}
	</DialogPrimitive.Content>
</DialogPortal>

<style>
	@keyframes dialog-spring-in {
		0% {
			opacity: 0;
			scale: 0.96;
			translate: 0 12px;
		}
		100% {
			opacity: 1;
			scale: 1;
			translate: 0 0;
		}
	}

	:global([data-slot="dialog-content"]) {
		background: var(--color-glass-bg);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--color-glass-border);
	}

	:global([data-slot="dialog-content"][data-state="open"]) {
		animation: dialog-spring-in 320ms cubic-bezier(0.16, 1, 0.3, 1) both;
	}
</style>
