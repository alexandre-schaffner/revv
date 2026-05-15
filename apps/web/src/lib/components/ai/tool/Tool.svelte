<script lang="ts" module>
	import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

	export type ToolProps = CollapsiblePrimitive.RootProps;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { Collapsible } from "$lib/components/ui/collapsible/index.js";

	let {
		open = $bindable(false),
		children,
		class: className,
		...restProps
	}: ToolProps = $props();
</script>

<Collapsible
	data-slot="tool"
	class={cn("rounded-lg border border-border bg-background", className)}
	bind:open
	{...restProps}
>
	{@render children?.()}
</Collapsible>
