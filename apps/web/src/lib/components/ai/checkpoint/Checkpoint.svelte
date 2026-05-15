<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";

	export type CheckpointProps = HTMLAttributes<HTMLDivElement> & {
		/** Unique identifier for this checkpoint. */
		id: string;
		/** Display label for the checkpoint. */
		label?: string | undefined;
		/** Callback when the user requests to restore to this checkpoint. */
		onRestore?: (id: string) => void;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import { RotateCcw, Flag } from "@lucide/svelte";

	let {
		id: checkpointId,
		label,
		onRestore,
		children,
		class: className,
		...restProps
	}: CheckpointProps = $props();
</script>

<div
	data-slot="checkpoint"
	data-checkpoint-id={checkpointId}
	class={cn(
		"group/checkpoint flex items-center gap-2 py-2",
		className,
	)}
	role="separator"
	aria-label={label ?? "Checkpoint"}
	{...restProps}
>
	<div class="h-px flex-1 bg-border"></div>
	<div class="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
		<Flag class="size-3" />
		<span>{label ?? "Checkpoint"}</span>
		{#if onRestore}
			<Button
				variant="ghost"
				size="icon-xs"
				class="opacity-0 transition-opacity duration-snap group-hover/checkpoint:opacity-100"
				onclick={() => onRestore(checkpointId)}
				aria-label="Restore to this checkpoint"
			>
				<RotateCcw class="size-3" />
			</Button>
		{/if}
	</div>
	<div class="h-px flex-1 bg-border"></div>
</div>
