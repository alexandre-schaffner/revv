<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type PromptInputHeaderProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: PromptInputHeaderProps = $props();
</script>

<div
	data-slot="prompt-input-header"
	class={cn("", className)}
	{...restProps}
>
	{@render children?.()}
</div>
