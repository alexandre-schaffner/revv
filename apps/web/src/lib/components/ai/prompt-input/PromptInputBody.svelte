<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";

	export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		children,
		class: className,
		...restProps
	}: PromptInputBodyProps = $props();
</script>

<div
	data-slot="prompt-input-body"
	class={cn("relative", className)}
	{...restProps}
>
	{@render children?.()}
</div>
