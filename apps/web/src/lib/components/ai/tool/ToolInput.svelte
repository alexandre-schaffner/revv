<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";

	export type ToolInputProps = HTMLAttributes<HTMLDivElement> & {
		/** The input parameters passed to the tool (displayed as formatted JSON). */
		input?: unknown;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		input,
		class: className,
		...restProps
	}: ToolInputProps = $props();

	let formatted = $derived(
		input !== undefined ? JSON.stringify(input, null, 2) : "",
	);
</script>

{#if formatted}
	<div
		data-slot="tool-input"
		class={cn("", className)}
		{...restProps}
	>
		<p class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Input</p>
		<pre class="overflow-x-auto rounded-md bg-muted p-3 text-xs font-mono"><code>{formatted}</code></pre>
	</div>
{/if}
