<script lang="ts">
import { fromAction } from "svelte/attachments";
import type { HTMLAttributes } from "svelte/elements";
import { isHighlighterReady } from "$lib/markdown/highlighter.svelte";
import { prlensDiagrams } from "$lib/markdown/prlens-diagrams";
import { createFadeRenderer, type MarkdownTrust, renderMarkdownBlocks } from "$lib/markdown/render";
import { getResolvedTheme } from "$lib/stores/theme.svelte";
import { cn } from "$lib/utils";
import { interceptExternalLinks } from "$lib/utils/open-external";

type Props = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  source: string;
  /** Side panels and threads read at the dense size. */
  density?: "regular" | "dense";
} & (
    | {
        trust: Extract<MarkdownTrust, "agent">;
        /** Fade in the characters each new `source` adds, for text still streaming. */
        fade?: boolean;
      }
    | { trust: Extract<MarkdownTrust, "external">; fade?: never }
  );

let {
  source,
  trust,
  density = "regular",
  fade = false,
  class: className,
  onclick,
  ...rest
}: Props = $props();

const renderFade = createFadeRenderer();

const blocks = $derived.by(() => {
  // A render before Shiki loads holds plain `<pre>`; re-render once it has.
  void isHighlighterReady();
  return fade ? [renderFade(source)] : renderMarkdownBlocks(source, trust);
});

function handleClick(event: MouseEvent & { currentTarget: EventTarget & HTMLDivElement }): void {
  interceptExternalLinks(event);
  onclick?.(event);
}
</script>

<!-- Clicks only reroute links, which stay keyboard-reachable on their own. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
	{...rest}
	class={cn("prose prose-sm", density === "dense" && "prose-dense", className)}
	onclick={handleClick}
	{@attach trust === "agent" ? fromAction(prlensDiagrams, getResolvedTheme) : null}
>
	{#each blocks as block}{@html block}{/each}
</div>
