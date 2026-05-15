<script lang="ts" module>
import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

export type PlanProps = CollapsiblePrimitive.RootProps & {
  /** Whether content is currently streaming. Enables shimmer animations. */
  isStreaming?: boolean;
};
</script>

<script lang="ts">
	import { setContext } from "svelte";
	import { cn } from "$lib/utils.js";
	import { Collapsible } from "$lib/components/ui/collapsible/index.js";
	import { PLAN_CTX_KEY, type PlanContext } from "./context.js";

	let {
		isStreaming = false,
		open = $bindable(true),
		children,
		class: className,
		...restProps
	}: PlanProps = $props();

	const ctx: PlanContext = {
		get isStreaming() { return isStreaming; },
	};
	setContext(PLAN_CTX_KEY, ctx);
</script>

<Collapsible
	data-slot="plan"
	class={cn(
		"rounded-lg border border-border bg-background shadow-none",
		className,
	)}
	bind:open
	{...restProps}
>
	{@render children?.()}
</Collapsible>
