<script lang="ts" module>
	import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

	export type ReasoningContentProps = CollapsiblePrimitive.ContentProps & {
		/** The reasoning text to render as markdown. */
		content?: string;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { CollapsibleContent } from "$lib/components/ui/collapsible/index.js";
	import { renderMarkdown } from "$lib/utils/markdown.js";

	let {
		content,
		children,
		class: className,
		...restProps
	}: ReasoningContentProps = $props();

	let html = $derived(content ? renderMarkdown(content) : "");
</script>

<CollapsibleContent
	data-slot="reasoning-content"
	class={cn(
		"overflow-hidden border-l-2 border-muted pl-3 ml-[9px] mt-1",
		className,
	)}
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else if html}
		<div class="prose-sm max-w-none text-xs text-muted-foreground">
			{@html html}
		</div>
	{/if}
</CollapsibleContent>
