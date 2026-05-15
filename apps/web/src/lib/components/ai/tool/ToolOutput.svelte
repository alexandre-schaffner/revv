<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";
	import type { Snippet } from "svelte";

	export type ToolOutputProps = HTMLAttributes<HTMLDivElement> & {
		/** The output/result snippet of the tool execution. */
		output?: Snippet;
		/** An error message if the tool execution failed. */
		errorText?: string;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { AlertCircle } from "@lucide/svelte";

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
		class={cn("", className)}
		{...restProps}
	>
		{#if errorText}
			<div class="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
				<AlertCircle class="mt-0.5 size-3.5 shrink-0" />
				<span>{errorText}</span>
			</div>
		{:else if output}
			<p class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Output</p>
			{@render output()}
		{/if}
	</div>
{/if}
