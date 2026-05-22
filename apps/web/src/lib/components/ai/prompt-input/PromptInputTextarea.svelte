<script lang="ts" module>
import type { HTMLTextareaAttributes } from "svelte/elements";

export type PromptInputTextareaProps = HTMLTextareaAttributes & {
  /** Placeholder text. */
  placeholder?: string;
};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { getContext } from "svelte";
	import { PROMPT_INPUT_CTX_KEY, type PromptInputContext } from "./context.js";

	let {
		placeholder = "Type a message...",
		class: className,
		...restProps
	}: PromptInputTextareaProps = $props();

	const ctx = getContext<PromptInputContext>(PROMPT_INPUT_CTX_KEY);
	let textareaEl: HTMLTextAreaElement | undefined = $state(undefined);

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			ctx.submit();
		}
	}

	function autoResize() {
		if (!textareaEl) return;
		// Empty: defer to CSS min-height. Measuring scrollHeight during the
		// first layout pass of the floating composer can latch oversized.
		if (!ctx.value) {
			textareaEl.style.height = "";
			return;
		}
		textareaEl.style.height = "auto";
		textareaEl.style.height = Math.min(textareaEl.scrollHeight, 160) + "px";
	}

	$effect(() => {
		// Track ctx.value so autoResize fires on programmatic clear/fill.
		void ctx.value;
		autoResize();
	});
</script>

<textarea
	bind:this={textareaEl}
	value={ctx.value}
	oninput={(e) => {
		ctx.setValue(e.currentTarget.value);
		autoResize();
	}}
	data-slot="prompt-input-textarea"
	class={cn(
		"block w-full min-h-[2.75rem] resize-none bg-transparent px-4 py-3 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none",
		className,
	)}
	{placeholder}
	rows={1}
	onkeydown={handleKeydown}
	{...restProps}
></textarea>
