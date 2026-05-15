<script lang="ts" module>
import type { Snippet } from "svelte";
import type { HTMLAttributes } from "svelte/elements";

export type ConversationEmptyStateProps = HTMLAttributes<HTMLDivElement> & {
  /** Title text to display. */
  title?: string;
  /** Description text to display. */
  description?: string;
  /** Icon snippet rendered above the text. */
  icon?: Snippet;
};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		title = "No messages yet",
		description = "Start a conversation to see messages here",
		icon,
		children,
		class: className,
		...restProps
	}: ConversationEmptyStateProps = $props();
</script>

<div
	data-slot="conversation-empty-state"
	class={cn(
		"flex flex-1 flex-col items-center justify-center gap-3 px-4 py-12 text-center text-muted-foreground",
		className,
	)}
	{...restProps}
>
	{#if icon}
		<div class="opacity-40">
			{@render icon()}
		</div>
	{/if}
	{#if title}
		<h3 class="text-sm font-medium">{title}</h3>
	{/if}
	{#if description}
		<p class="max-w-[280px] text-xs">{description}</p>
	{/if}
	{@render children?.()}
</div>
