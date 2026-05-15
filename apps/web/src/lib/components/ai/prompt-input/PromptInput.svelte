<script lang="ts" module>
	import type { HTMLFormAttributes } from "svelte/elements";
	import type { PromptInputMessage, PromptInputStatus } from "./context.js";

	export type PromptInputProps = Omit<HTMLFormAttributes, "onsubmit"> & {
		/** Two-way bound text value. Shared with PromptInputTextarea via bind:value on both. */
		value?: string;
		/** Handler called when the form is submitted with message text. */
		onsubmit?: (message: PromptInputMessage) => void;
		/** Current chat status. */
		status?: PromptInputStatus;
		/** Handler called when a stop is requested. */
		onstop?: () => void;
	};
</script>

<script lang="ts">
	import { setContext } from "svelte";
	import { cn } from "$lib/utils.js";
	import { PROMPT_INPUT_CTX_KEY, type PromptInputContext } from "./context.js";

	let {
		value = $bindable(""),
		onsubmit: onSubmit,
		onstop: onStop,
		status = "ready",
		children,
		class: className,
		...restProps
	}: PromptInputProps = $props();

	function submit() {
		const trimmed = value.trim();
		if (!trimmed) return;
		onSubmit?.({ text: trimmed });
		value = "";
	}

	function stop() {
		onStop?.();
	}

	function handleFormSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (status === "streaming" || status === "submitted") {
			stop();
		} else {
			submit();
		}
	}

	const ctx: PromptInputContext = {
		get status() { return status; },
		get value() { return value; },
		setValue(v: string) { value = v; },
		submit,
		stop,
	};
	setContext(PROMPT_INPUT_CTX_KEY, ctx);
</script>

<form
	data-slot="prompt-input"
	class={cn(
		"relative flex flex-col rounded-xl border border-border bg-background shadow-xs",
		className,
	)}
	onsubmit={handleFormSubmit}
	{...restProps}
>
	{@render children?.()}
</form>
