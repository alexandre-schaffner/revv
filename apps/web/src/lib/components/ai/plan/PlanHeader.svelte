<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type PlanHeaderProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: PlanHeaderProps = $props();
</script>

<div
	data-slot="plan-header"
	class={cn("flex items-start justify-between gap-2 px-4 pt-3 pb-2", className)}
	{...restProps}
>
	{@render children?.()}
</div>
