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
  /**
   * Turn `@path` file mentions in the text into file pills. Enabled for user
   * messages, where mentions are written as plain text.
   */
  mentionPills?: boolean;
};
</script>

<script lang="ts">
	import { getContext } from "svelte";
	import { fileReferences } from "$lib/actions/file-references.svelte";
	import { mentionReferences } from "$lib/actions/mention-references.svelte";
	import { getReviewFiles } from "$lib/stores/review.svelte";
	import { cn } from "$lib/utils.js";
	import { renderMarkdown } from "$lib/utils/markdown.js";
	import { MESSAGE_CTX_KEY, type MessageContext } from "./context.js";

	let {
		content,
		parseIncompleteMarkdown = true,
		linkifyFiles = false,
		mentionPills = false,
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
	use:mentionReferences={mentionPills ? getReviewFiles() : null}
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
	/* `.file-ref` (assistant inline-code paths) and `.mention-ref` (user `@`
	   mentions) are injected into `{@html}` content by their actions, so they
	   must be global. Both render as a squarer pill with the per-extension
	   file-type glyph — matching the tool-call detail pill. */
	:global([data-slot='message-response'] code.file-ref),
	:global([data-slot='message-response'] .mention-ref) {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.0625rem 0.375rem;
		border-radius: 0.3125rem;
		border: 1px solid var(--color-border);
		background: color-mix(in srgb, var(--color-muted) 55%, transparent);
		font-size: 0.8125em;
		vertical-align: baseline;
		transition:
			background-color var(--duration-snap) var(--ease-standard),
			border-color var(--duration-snap) var(--ease-standard);
	}
	/* Clickable (resolved) refs get a pointer; unresolved mentions stay inert. */
	:global([data-slot='message-response'] code.file-ref),
	:global([data-slot='message-response'] .mention-ref[data-mention-path]) {
		cursor: pointer;
	}
	/* Strip the prose inline-code chrome (backtick quotes, its own bg). */
	:global([data-slot='message-response'] code.file-ref)::before,
	:global([data-slot='message-response'] code.file-ref)::after {
		content: none;
	}
	:global([data-slot='message-response'] code.file-ref:hover),
	:global([data-slot='message-response'] code.file-ref:focus-visible),
	:global([data-slot='message-response'] .mention-ref[data-mention-path]:hover),
	:global([data-slot='message-response'] .mention-ref[data-mention-path]:focus-visible) {
		border-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
		outline: none;
	}
	:global([data-slot='message-response'] .file-ref-icon),
	:global([data-slot='message-response'] .mention-ref-icon) {
		width: 0.9em;
		height: 0.9em;
		flex-shrink: 0;
	}
	/* On the teal accent bubble a translucent-white chip leaves white text at
	   ~4.3:1 (below AA) and muddies the file glyph's color. Flip it to a solid,
	   brand-tinted light chip: ink-deep teal text hits ~11:1, the per-extension
	   glyph keeps its meaningful color on a surface bright enough to carry it,
	   and the chip separates from the bubble at ~5.6:1. Tinted toward the brand
	   hue (195), never raw #fff, per the design system. */
	:global([data-slot='message-response'].prose-on-accent .mention-ref) {
		border-color: oklch(88% 0.02 195);
		background: oklch(96% 0.012 195);
		color: oklch(32% 0.03 195);
	}
	:global([data-slot='message-response'].prose-on-accent .mention-ref[data-mention-path]:hover) {
		border-color: oklch(80% 0.04 195);
		background: oklch(92% 0.022 195);
	}
</style>
