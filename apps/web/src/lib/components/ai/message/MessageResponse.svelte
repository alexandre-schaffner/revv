<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";

	export type MessageResponseProps = HTMLAttributes<HTMLDivElement> & {
		/** The markdown content to render. */
		content: string;
		/** Whether to attempt fixing incomplete markdown (unclosed code blocks, etc). */
		parseIncompleteMarkdown?: boolean;
	};
</script>

<script lang="ts">
	import { getContext } from "svelte";
	import { cn } from "$lib/utils.js";
	import { renderMarkdown } from "$lib/utils/markdown.js";
	import { MESSAGE_CTX_KEY, type MessageContext } from "./context.js";

	let {
		content,
		parseIncompleteMarkdown = true,
		class: className,
		...restProps
	}: MessageResponseProps = $props();

	const ctx = getContext<MessageContext | undefined>(MESSAGE_CTX_KEY);

	function fixIncomplete(md: string): string {
		if (!parseIncompleteMarkdown) return md;
		// Close unclosed fenced code blocks
		const fences = md.match(/^```/gm);
		if (fences && fences.length % 2 !== 0) {
			md += "\n```";
		}
		return md;
	}

	let html = $derived(renderMarkdown(fixIncomplete(content)));
</script>

<div
	data-slot="message-response"
	class={cn(
		"prose-sm max-w-none",
		ctx?.role === "user"
			? "rounded-2xl bg-secondary px-4 py-2.5 text-secondary-foreground"
			: "text-foreground",
		className,
	)}
	{...restProps}
>
	{@html html}
</div>
