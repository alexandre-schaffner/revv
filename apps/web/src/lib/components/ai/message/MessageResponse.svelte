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
	import { renderMarkdownBlocks } from "$lib/utils/markdown.js";
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

	let blocks = $derived(renderMarkdownBlocks(fixIncomplete(content)));
</script>

<div
	data-slot="message-response"
	use:fileReferences={linkifyFiles ? getReviewFiles() : null}
	use:mentionReferences={mentionPills ? getReviewFiles() : null}
	class={cn(
		"prose prose-sm max-w-none min-w-0 break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_.shiki]:max-w-full [&_.shiki]:overflow-x-auto",
		// A user bubble is sized to fit-content inside `items-end` columns, so
		// it can't be narrower than its min-content. `break-words` doesn't lower
		// min-content; `wrap-anywhere` does, so a long file path wraps instead
		// of widening the bubble past the pane and clipping its left edge.
		// Tables and code blocks set their own min-content (`max-content`,
		// `white-space: pre`), so the bubble also caps at its column and
		// lets them scroll inside it. Important, because prose.css's unlayered
		// `.prose { max-width: none }` outranks a layered utility.
		ctx?.role === "user" && "max-w-full! rounded-2xl bg-secondary px-4 py-2.5 wrap-anywhere",
		className,
	)}
	{...restProps}
>
	{#each blocks as block}{@html block}{/each}
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
	/* Inside the teal-tinted user bubble a pill takes the bubble's own chip
	   tint, so it doesn't read as a warm patch on a cool surface. Hover still
	   goes to the accent (the hover rule above is more specific). */
	:global([data-slot='message-response'].prose-user-bubble .mention-ref) {
		border-color: var(--color-user-bubble-border);
		background: var(--color-user-bubble-chip);
	}
</style>
