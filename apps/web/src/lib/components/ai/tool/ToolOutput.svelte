<script lang="ts" module>
import type { Snippet } from "svelte";
import type { HTMLAttributes } from "svelte/elements";

export type ToolOutputProps = HTMLAttributes<HTMLDivElement> & {
  /** The output/result snippet of the tool execution. */
  output?: Snippet;
  /** An error message if the tool execution failed. */
  errorText?: string;
};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		output,
		errorText,
		class: className,
		...restProps
	}: ToolOutputProps = $props();
</script>

{#if output || errorText}
	<div
		data-slot="tool-output"
		class={cn("space-y-2", className)}
		{...restProps}
	>
		<h4 class="font-medium text-muted-foreground text-xs uppercase tracking-wide">
			{errorText ? "Error" : "Result"}
		</h4>
		<div
			class={cn(
				"overflow-x-auto rounded-md text-xs [&_table]:w-full",
				errorText
					? "bg-destructive/10 text-destructive"
					: "bg-muted/50 text-foreground",
			)}
		>
			{#if errorText}
				<div class="p-3">{errorText}</div>
			{:else if output}
				{@render output()}
			{/if}
		</div>
	</div>
{/if}
