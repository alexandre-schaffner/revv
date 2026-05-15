<script lang="ts" module>
	import type { HTMLButtonAttributes } from "svelte/elements";
	import type { Snippet } from "svelte";

	export type SuggestionItemProps = HTMLButtonAttributes & {
		/** The suggestion text sent when clicked. Defaults to the rendered text content. */
		value?: string;
		/** Callback when the suggestion is selected. */
		onSelect?: (value: string) => void;
		/** Leading icon snippet. */
		icon?: Snippet;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		value,
		onSelect,
		icon,
		children,
		class: className,
		disabled,
		...restProps
	}: SuggestionItemProps = $props();

	let ref: HTMLButtonElement | undefined = $state();

	function handleClick() {
		if (disabled) return;
		const text = value ?? ref?.textContent?.trim() ?? "";
		onSelect?.(text);
	}
</script>

<button
	bind:this={ref}
	data-slot="suggestion-item"
	type="button"
	class={cn(
		"inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-all duration-snap",
		"hover:bg-muted hover:border-muted-foreground/20",
		"focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
		"active:scale-[0.97]",
		"disabled:pointer-events-none disabled:opacity-50",
		className,
	)}
	{disabled}
	onclick={handleClick}
	{...restProps}
>
	{#if icon}
		<span class="shrink-0 [&>svg]:size-3.5">{@render icon()}</span>
	{/if}
	<span>{@render children?.()}</span>
</button>
