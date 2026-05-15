<script lang="ts" module>
import type { ButtonProps } from "$lib/components/ui/button/index.js";

/**
 * Status, value, and submit-on-empty behavior are all read from the parent
 * `<PromptInput>` via context. Any `disabled` prop the caller passes is
 * applied additively (e.g., a parent might disable while no PR is loaded).
 */
export type PromptInputSubmitProps = ButtonProps;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { getContext } from "svelte";
	import { Button } from "$lib/components/ui/button/index.js";
	import { ArrowUp, Square, Loader2, AlertCircle } from "@lucide/svelte";
	import { PROMPT_INPUT_CTX_KEY, type PromptInputContext } from "./context.js";

	let {
		class: className,
		disabled,
		...restProps
	}: PromptInputSubmitProps = $props();

	const ctx = getContext<PromptInputContext>(PROMPT_INPUT_CTX_KEY);
	const status = $derived(ctx.status);
	const isReady = $derived(status === "ready");
	const isEmpty = $derived(ctx.value.trim().length === 0);
	// In "ready" state the form is the send action — disable when the buffer is
	// empty or the parent has explicitly disabled. In streaming/submitted, the
	// button is a stop action and stays enabled (the parent's `disabled` is
	// ignored to keep the abort path always accessible).
	const finalDisabled = $derived(isReady && (isEmpty || !!disabled));
</script>

<Button
	data-slot="prompt-input-submit"
	type="submit"
	size="icon-sm"
	variant={status === "streaming" || status === "submitted" ? "outline" : "default"}
	class={cn("shrink-0", className)}
	disabled={finalDisabled}
	aria-label={status === "streaming" || status === "submitted" ? "Stop" : "Send"}
	{...restProps}
>
	{#if status === "error"}
		<AlertCircle class="size-3.5" />
	{:else if status === "submitted"}
		<Loader2 class="size-3.5 motion-essential-spin animate-spin" />
	{:else if status === "streaming"}
		<Square class="size-3" />
	{:else}
		<ArrowUp class="size-3.5" />
	{/if}
</Button>
