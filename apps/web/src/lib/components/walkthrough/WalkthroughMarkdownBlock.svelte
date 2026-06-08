<script lang="ts">
import { mermaidDiagrams } from "$lib/actions/mermaid.svelte";
import { getResolvedTheme } from "$lib/stores/theme.svelte";
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
	<div class="prose prose-sm" use:mermaidDiagrams={getResolvedTheme()}>
		{@html renderedContent}
	</div>
</div>
