<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";

	export type ConfirmationContentProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: ConfirmationContentProps = $props();
</script>

<div
	data-slot="confirmation-content"
	class={cn("border-t border-border px-3 py-2.5", className)}
	{...restProps}
>
	{@render children?.()}
</div>
