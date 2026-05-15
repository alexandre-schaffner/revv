<script lang="ts" module>
	import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

	export type ChainOfThoughtProps = CollapsiblePrimitive.RootProps;
</script>

<script lang="ts">
	import { setContext } from "svelte";
	import { cn } from "$lib/utils.js";
	import { Collapsible } from "$lib/components/ui/collapsible/index.js";
	import { COT_CTX_KEY, type ChainOfThoughtContext } from "./context.js";

	let {
		open = $bindable(false),
		children,
		class: className,
		...restProps
	}: ChainOfThoughtProps = $props();

	const ctx: ChainOfThoughtContext = {
		get isOpen() { return open; },
	};
	setContext(COT_CTX_KEY, ctx);
</script>

<Collapsible
	data-slot="chain-of-thought"
	class={cn("w-full", className)}
	bind:open
	{...restProps}
>
	{@render children?.()}
</Collapsible>
