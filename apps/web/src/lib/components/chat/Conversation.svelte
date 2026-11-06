<script lang="ts">
// Scroll container for the timeline: follows new content while the reader is
// at the bottom, offers a jump back down otherwise, and snaps to the bottom
// when `resetKey` (the PR) changes.
import ArrowDown from "phosphor-svelte/lib/ArrowDown";
import { type Snippet, tick } from "svelte";
import { Button } from "$lib/components/ui/button/index.js";

interface Props {
  resetKey: unknown;
  children: Snippet;
}

let { resetKey, children }: Props = $props();

let scrollEl = $state<HTMLDivElement | undefined>(undefined);
let isAtBottom = $state(true);

function scrollToBottom() {
  scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" });
}

function handleScroll() {
  if (!scrollEl) return;
  const { scrollTop, scrollHeight, clientHeight } = scrollEl;
  isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
}

$effect(() => {
  void resetKey;
  void tick().then(() => {
    if (!scrollEl) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
    isAtBottom = true;
  });
});

$effect(() => {
  const el = scrollEl;
  const contentEl = el?.firstElementChild;
  if (!el || !contentEl) return;
  const observer = new ResizeObserver(() => {
    if (isAtBottom) el.scrollTop = el.scrollHeight;
  });
  observer.observe(contentEl);
  return () => observer.disconnect();
});
</script>

<div data-slot="conversation" class="relative flex flex-1 flex-col overflow-hidden">
	<div
		bind:this={scrollEl}
		class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
		onscroll={handleScroll}
	>
		{@render children()}
	</div>
	{#if !isAtBottom}
		<div class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-4">
			<Button
				data-slot="conversation-scroll-button"
				variant="outline"
				size="icon-sm"
				class="pointer-events-auto rounded-full shadow-md"
				onclick={scrollToBottom}
				aria-label="Scroll to bottom"
			>
				<ArrowDown class="size-3.5" />
			</Button>
		</div>
	{/if}
</div>
