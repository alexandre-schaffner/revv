<script lang="ts">
// Markdown body of a chat message. In agent messages, inline-code paths that
// match a changed file open it in the diff tab; in user messages, `@path`
// mentions render as file pills.
import { fileReferences } from "$lib/actions/file-references.svelte";
import { mentionReferences } from "$lib/actions/mention-references.svelte";
import { getReviewFiles } from "$lib/stores/review.svelte";
import { renderMarkdownBlocks } from "$lib/utils/markdown.js";
import { cn } from "$lib/utils.js";

interface Props {
  from: "user" | "assistant";
  content: string;
  class?: string;
}

let { from, content, class: className }: Props = $props();

/** Close an unclosed code fence so a streaming block renders as code. */
function closeOpenFence(md: string): string {
  const fences = md.match(/^```/gm);
  return fences && fences.length % 2 !== 0 ? `${md}\n\`\`\`` : md;
}

const blocks = $derived(renderMarkdownBlocks(closeOpenFence(content)));
</script>

<div
	data-slot="message-response"
	use:fileReferences={from === "assistant" ? getReviewFiles() : null}
	use:mentionReferences={from === "user" ? getReviewFiles() : null}
	class={cn(
		"prose prose-sm max-w-none min-w-0 break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_.shiki]:max-w-full [&_.shiki]:overflow-x-auto",
		// A user bubble sits in an `items-end` column, so it is never narrower
		// than its min-content; `wrap-anywhere` lowers that so a long path wraps
		// instead of pushing the bubble past the pane. `max-w-full!` because
		// prose.css's unlayered `.prose { max-width: none }` beats a layered
		// utility.
		from === "user" && "max-w-full! rounded-2xl bg-secondary px-4 py-2.5 wrap-anywhere",
		className,
	)}
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
