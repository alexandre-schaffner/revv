<script lang="ts">
import { renderUntrustedMarkdown } from "$lib/utils/markdown";
import { interceptExternalLinks } from "$lib/utils/open-external";

// Markdown someone on GitHub wrote (a PR body, a comment, a review, a check
// summary), rendered under the strict sanitizer, with its links leaving the
// webview for the browser.

interface Props {
  source: string;
}

let { source }: Props = $props();

const html = $derived(renderUntrustedMarkdown(source));
</script>

<!-- The click handler only reroutes links, which stay keyboard-reachable on
     their own. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="markdown-body prose prose-sm prose-dense" onclick={interceptExternalLinks}>
	{@html html}
</div>

<style>
	.markdown-body {
		max-width: none;
		overflow-wrap: anywhere;
	}
</style>
