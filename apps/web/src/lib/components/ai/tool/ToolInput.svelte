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
		class={cn("space-y-2 overflow-hidden", className)}
		{...restProps}
	>
		<h4 class="font-medium text-muted-foreground text-xs uppercase tracking-wide">Parameters</h4>
		<div class="rounded-md bg-muted/50">
			<pre class="overflow-x-auto p-3 text-xs font-mono"><code>{formatted}</code></pre>
		</div>
	</div>
{/if}
