<script lang="ts">
import { isHighlighterReady } from "$lib/utils/code-highlight.svelte";
import { renderMarkdown } from "$lib/utils/markdown";

interface Props {
  content: string;
}

let { content }: Props = $props();

// Re-derive when highlighter becomes ready so code blocks get highlighted
const highlighterReady = $derived(isHighlighterReady());
const renderedContent = $derived.by(() => {
  void highlighterReady;
  return renderMarkdown(content);
});
</script>

<div class="markdown-block">
	<!-- Markdown styling comes from the app-wide themed @tailwindcss/typography
	     prose layer (see app.css). -->
	<div class="prose prose-sm">
		{@html renderedContent}
	</div>
</div>
