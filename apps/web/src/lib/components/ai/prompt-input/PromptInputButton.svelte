<script lang="ts" module>
	import type { ButtonProps } from "$lib/components/ui/button/index.js";

	export type PromptInputButtonProps = ButtonProps & {
		/** Optional tooltip configuration. */
		tooltip?: string | { content: string; shortcut?: string };
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import * as Tooltip from "$lib/components/ui/tooltip/index.js";

	let {
		tooltip,
		children,
		class: className,
		...restProps
	}: PromptInputButtonProps = $props();

	const tooltipText = $derived(
		typeof tooltip === "string" ? tooltip : tooltip?.content,
	);
	const tooltipShortcut = $derived(
		typeof tooltip === "object" ? tooltip?.shortcut : undefined,
	);
</script>

{#if tooltip}
	<Tooltip.Root>
		<Tooltip.Trigger>
			<Button
				data-slot="prompt-input-button"
				variant="ghost"
				size="sm"
				class={cn("gap-1.5 text-muted-foreground", className)}
				type="button"
				{...restProps}
			>
				{@render children?.()}
			</Button>
		</Tooltip.Trigger>
		<Tooltip.Content>
			<span>{tooltipText}</span>
			{#if tooltipShortcut}
				<kbd class="ml-1.5 rounded border border-border bg-muted px-1 py-0.5 text-[10px] font-mono">
					{tooltipShortcut}
				</kbd>
			{/if}
		</Tooltip.Content>
	</Tooltip.Root>
{:else}
	<Button
		data-slot="prompt-input-button"
		variant="ghost"
		size="sm"
		class={cn("gap-1.5 text-muted-foreground", className)}
		type="button"
		{...restProps}
	>
		{@render children?.()}
	</Button>
{/if}
