<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type ConfirmationHeaderProps = HTMLAttributes<HTMLDivElement> & {
  title: string;
  description?: string | undefined;
};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { ShieldQuestion } from "@lucide/svelte";

	let {
		title,
		description,
		children,
		class: className,
		...restProps
	}: ConfirmationHeaderProps = $props();
</script>

<div
	data-slot="confirmation-header"
	class={cn("flex items-start gap-3 px-3 py-3", className)}
	{...restProps}
>
	<div class="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
		<ShieldQuestion class="size-4 text-muted-foreground" />
	</div>
	<div class="min-w-0 flex-1">
		<p class="text-sm font-medium text-foreground">{title}</p>
		{#if description}
			<p class="mt-0.5 text-xs text-muted-foreground">{description}</p>
		{/if}
	</div>
	{@render children?.()}
</div>
