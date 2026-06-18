<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type MessageResponseProps = HTMLAttributes<HTMLDivElement> & {
  /** The markdown content to render. */
  content: string;
  /** Whether to attempt fixing incomplete markdown (unclosed code blocks, etc). */
  parseIncompleteMarkdown?: boolean;
  /**
   * Turn inline-code file paths that match a changed file into clickable
   * references that open the file in the diff tab. Enabled for chat agent
   * messages.
   */
  linkifyFiles?: boolean;
};
</script>

<script lang="ts">
	import { getContext } from "svelte";
	import { fileReferences } from "$lib/actions/file-references.svelte";
	import { getReviewFiles } from "$lib/stores/review.svelte";
	import { cn } from "$lib/utils.js";
	import { renderMarkdown } from "$lib/utils/markdown.js";
	import { MESSAGE_CTX_KEY, type MessageContext } from "./context.js";

	let {
		content,
		parseIncompleteMarkdown = true,
		linkifyFiles = false,
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
	use:fileReferences={linkifyFiles ? getReviewFiles() : null}
	class={cn(
		"prose prose-sm max-w-none min-w-0 break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_.shiki]:max-w-full [&_.shiki]:overflow-x-auto",
		ctx?.role === "user" && "rounded-2xl bg-secondary px-4 py-2.5",
		className,
	)}
	{...restProps}
>
	{@html html}
</div>

<style>
	/* `.file-ref` is applied to `{@html}` content by the `fileReferences`
	   action, so it must be global. Builds on the prose inline-code styling
	   with a click affordance: pointer + accent on hover/focus. */
	:global([data-slot='message-response'] code.file-ref) {
		cursor: pointer;
		text-decoration-line: underline;
		text-decoration-style: dotted;
		text-underline-offset: 2px;
		transition: color var(--duration-snap) var(--ease-standard);
	}
	:global([data-slot='message-response'] code.file-ref:hover),
	:global([data-slot='message-response'] code.file-ref:focus-visible) {
		color: var(--color-primary);
		text-decoration-style: solid;
		outline: none;
	}
</style>
