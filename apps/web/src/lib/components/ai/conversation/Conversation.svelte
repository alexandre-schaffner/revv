<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type ConversationProps = HTMLAttributes<HTMLDivElement> & {
  /** Bind to read the inner scroll container (for imperative scroll control). */
  scrollEl?: HTMLDivElement | undefined;
  /**
   * Bind to observe whether the user is at the bottom of the scroll
   * container. Drives `ConversationScrollButton` visibility internally and
   * is exposed so parents can gate their own auto-follow logic.
   */
  isAtBottom?: boolean;
  /** Tailwind classes for the inner scroll container. The class prop styles the outer wrapper. */
  innerClass?: string;
  /**
   * When this value changes the scroll container snaps to the bottom
   * (e.g. pass the current PR/thread id so switching context lands at
   * the newest message).
   */
  resetKey?: unknown;
};
</script>

<script lang="ts">
	import { setContext, tick } from "svelte";
	import { cn } from "$lib/utils.js";
	import { CONVERSATION_CTX_KEY, type ConversationContext } from "./context.js";

	let {
		children,
		class: className,
		scrollEl = $bindable(undefined),
		isAtBottom = $bindable(true),
		innerClass,
		resetKey,
		...restProps
	}: ConversationProps = $props();

	function scrollToBottom() {
		scrollEl?.scrollTo({
			top: scrollEl.scrollHeight,
			behavior: "smooth",
		});
	}

	function handleScroll() {
		if (!scrollEl) return;
		const { scrollTop, scrollHeight, clientHeight } = scrollEl;
		isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
	}

	// Snap to bottom when key changes (e.g. PR switch).
	$effect(() => {
		void resetKey;
		void tick().then(() => {
			if (!scrollEl) return;
			scrollEl.scrollTop = scrollEl.scrollHeight;
			isAtBottom = true;
		});
	});

	// Auto-follow new content when user is at the bottom.
	$effect(() => {
		const el = scrollEl;
		if (!el) return;
		const contentEl = el.firstElementChild;
		if (!contentEl) return;
		const observer = new ResizeObserver(() => {
			if (isAtBottom) el.scrollTop = el.scrollHeight;
		});
		observer.observe(contentEl);
		return () => observer.disconnect();
	});

	const ctx: ConversationContext = {
		get isAtBottom() {
			return isAtBottom;
		},
		scrollToBottom,
	};
	setContext(CONVERSATION_CTX_KEY, ctx);
</script>

<div
	data-slot="conversation"
	class={cn("relative flex flex-1 flex-col overflow-hidden", className)}
	{...restProps}
>
	<div
		bind:this={scrollEl}
		class={cn("flex-1 overflow-x-hidden overflow-y-auto", innerClass)}
		onscroll={handleScroll}
	>
		{@render children?.()}
	</div>
</div>
