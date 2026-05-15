<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";
	import type { Snippet } from "svelte";

	export type InlineCitationProps = HTMLAttributes<HTMLElement> & {
		/** The citation index/number displayed inline. */
		index: number;
		/** The source title or label. */
		title: string;
		/** The source URL (for link citations). */
		href?: string;
		/** A snippet describing or quoting the source. */
		description?: string;
		/** Full preview snippet rendered in the hover card. */
		preview?: Snippet;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import {
		Popover,
		PopoverTrigger,
		PopoverContent,
	} from "$lib/components/ui/popover/index.js";
	import { ExternalLink } from "@lucide/svelte";

	let {
		index,
		title,
		href,
		description,
		preview,
		class: className,
		...restProps
	}: InlineCitationProps = $props();
</script>

<Popover>
	<PopoverTrigger>
		{#snippet child({ props })}
			<sup
				{...props}
				data-slot="inline-citation"
				class={cn(
					"inline-flex size-4 cursor-pointer items-center justify-center rounded-full bg-primary/10 text-[9px] font-semibold text-primary transition-colors duration-snap hover:bg-primary/20",
					className,
				)}
				role="doc-noteref"
				aria-label="Citation {index}: {title}"
				{...restProps}
			>
				{index}
			</sup>
		{/snippet}
	</PopoverTrigger>
	<PopoverContent class="w-72 p-0" sideOffset={6}>
		<div class="space-y-2 p-3">
			<div class="flex items-start gap-2">
				<span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
					{index}
				</span>
				<div class="min-w-0 flex-1">
					{#if href}
						<a
							{href}
							target="_blank"
							rel="noopener noreferrer"
							class="flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
						>
							<span class="truncate">{title}</span>
							<ExternalLink class="size-3 shrink-0 text-muted-foreground" />
						</a>
					{:else}
						<p class="text-xs font-medium text-foreground">{title}</p>
					{/if}
					{#if description}
						<p class="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
					{/if}
				</div>
			</div>
			{#if preview}
				<div class="border-t border-border pt-2">
					{@render preview()}
				</div>
			{/if}
		</div>
	</PopoverContent>
</Popover>
