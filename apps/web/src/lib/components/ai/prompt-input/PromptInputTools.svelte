<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: PromptInputToolsProps = $props();
</script>

<div
	data-slot="prompt-input-tools"
	class={cn("flex items-center gap-1", className)}
	{...restProps}
>
	{@render children?.()}
</div>
