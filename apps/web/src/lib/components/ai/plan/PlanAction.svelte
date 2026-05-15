<script lang="ts" module>
	import type { ButtonProps } from "$lib/components/ui/button/index.js";

	export type PlanActionProps = ButtonProps;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { Button } from "$lib/components/ui/button/index.js";

	let {
		children,
		class: className,
		...restProps
	}: PlanActionProps = $props();
</script>

<Button
	data-slot="plan-action"
	size="sm"
	class={cn("", className)}
	{...restProps}
>
	{@render children?.()}
</Button>
