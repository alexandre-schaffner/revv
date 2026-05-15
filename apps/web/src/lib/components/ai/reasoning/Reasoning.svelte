<script lang="ts" module>
	import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

	export type ReasoningProps = CollapsiblePrimitive.RootProps & {
		/** Whether the reasoning is currently streaming (auto-opens and closes the panel). */
		isStreaming?: boolean;
		/** Duration in seconds to display. */
		duration?: number;
	};
</script>

<script lang="ts">
	import { setContext } from "svelte";
	import { cn } from "$lib/utils.js";
	import { Collapsible } from "$lib/components/ui/collapsible/index.js";
	import { REASONING_CTX_KEY, type ReasoningContext } from "./context.js";

	let {
		isStreaming = false,
		duration,
		open = $bindable(true),
		children,
		class: className,
		...restProps
	}: ReasoningProps = $props();

	let userToggled = $state(false);

	// Auto-open when streaming starts, auto-close when streaming ends
	$effect(() => {
		if (userToggled) return;
		if (isStreaming) {
			open = true;
		} else {
			open = false;
		}
	});

	function handleOpenChange(newOpen: boolean) {
		userToggled = true;
		open = newOpen;
	}

	const ctx: ReasoningContext = {
		get isStreaming() { return isStreaming; },
		get isOpen() { return open; },
		get duration() { return duration; },
	};
	setContext(REASONING_CTX_KEY, ctx);
</script>

<Collapsible
	data-slot="reasoning"
	class={cn("w-full", className)}
	bind:open
	onOpenChange={handleOpenChange}
	{...restProps}
>
	{@render children?.()}
</Collapsible>
