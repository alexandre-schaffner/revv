<script lang="ts" module>
import { LinkPreview } from "bits-ui";
import type { ComponentProps, Snippet } from "svelte";

export type ContextContentProps = Omit<ComponentProps<typeof LinkPreview.Content>, "children"> & {
  children?: Snippet;
};
</script>

<script lang="ts">
	import { cn } from '$lib/utils.js';

	let {
		children,
		class: className,
		side = 'top',
		align = 'end',
		sideOffset = 6,
		...restProps
	}: ContextContentProps = $props();
</script>

<LinkPreview.Portal>
	<LinkPreview.Content
		{side}
		{align}
		{sideOffset}
		data-slot="context-content"
		class={cn(
			'text-text-primary data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-64 origin-(--transform-origin) divide-y divide-border-subtle overflow-hidden rounded-xl p-0 text-sm outline-hidden duration-snap ease-out-expo',
			className,
		)}
		{...restProps}
	>
		{@render children?.()}
	</LinkPreview.Content>
</LinkPreview.Portal>

<style>
	:global([data-slot='context-content']) {
		background: var(--color-glass-bg);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--color-glass-border);
		box-shadow: var(--color-shadow-lg);
	}
</style>
