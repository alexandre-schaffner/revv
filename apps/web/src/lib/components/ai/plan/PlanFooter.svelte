<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";

	export type PlanFooterProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: PlanFooterProps = $props();
</script>

<div
	data-slot="plan-footer"
	class={cn("flex items-center justify-end gap-2 border-t border-border px-4 py-2", className)}
	{...restProps}
>
	{@render children?.()}
</div>
