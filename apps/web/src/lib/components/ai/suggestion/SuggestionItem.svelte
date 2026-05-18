<script lang="ts" module>
import type { Snippet } from "svelte";

export type SuggestionItemProps = {
  /** The suggestion text sent when clicked. Defaults to the rendered text content. */
  value?: string;
  /** Callback when the suggestion is selected. */
  onSelect?: (value: string) => void;
  /** Leading icon snippet. */
  icon?: Snippet;
  /** Additional CSS classes. */
  class?: string;
  /** Whether the button is disabled. */
  disabled?: boolean;
  /** Child content. */
  children?: Snippet;
};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { Button } from "$lib/components/ui/button/index.js";

	let {
		value,
		onSelect,
		icon,
		children,
		class: className,
		disabled,
	}: SuggestionItemProps = $props();

	let ref: HTMLElement | null = $state(null);

	function handleClick() {
		if (disabled) return;
		const text = value ?? ref?.textContent?.trim() ?? "";
		onSelect?.(text);
	}
</script>

<Button
	bind:ref
	data-slot="suggestion-item"
	type="button"
	variant="outline"
	size="sm"
	class={cn("h-auto max-w-full cursor-pointer whitespace-normal rounded-full px-4 py-1.5 text-center", className)}
	{disabled}
	onclick={handleClick}
>
	{#if icon}
		<span class="shrink-0 [&>svg]:size-3.5">{@render icon()}</span>
	{/if}
	{@render children?.()}
</Button>
