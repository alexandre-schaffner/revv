<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type PromptInputFooterProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: PromptInputFooterProps = $props();
</script>

<div
	data-slot="prompt-input-footer"
	class={cn("flex items-center justify-between gap-2 px-3 pb-2", className)}
	{...restProps}
>
	{@render children?.()}
</div>
