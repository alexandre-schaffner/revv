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
	};
</script>

<script lang="ts">
	import { setContext } from "svelte";
	import { cn } from "$lib/utils.js";
	import { CONVERSATION_CTX_KEY, type ConversationContext } from "./context.js";

	let {
		children,
		class: className,
		scrollEl = $bindable(undefined),
		isAtBottom = $bindable(true),
		innerClass,
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
		class={cn("flex-1 overflow-y-auto", innerClass)}
		onscroll={handleScroll}
	>
		{@render children?.()}
	</div>
</div>
