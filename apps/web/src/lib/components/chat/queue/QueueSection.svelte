<script lang="ts">
// One collapsible section of the queue dock: a header with a count, then a
// short scrolling list.
import CaretDown from "phosphor-svelte/lib/CaretDown";
import type { Snippet } from "svelte";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "$lib/components/ui/collapsible/index.js";
import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";

interface Props {
  label: string;
  count: number;
  open?: boolean;
  icon: Snippet;
  /** Right-aligned header detail. */
  trailing?: Snippet;
  /** The list's `<li>` rows. */
  children: Snippet;
  /** Rendered under the list. */
  footer?: Snippet;
}

let { label, count, open = $bindable(true), icon, trailing, children, footer }: Props = $props();
</script>

<Collapsible data-slot="queue-section" bind:open>
	<CollapsibleTrigger
		data-slot="queue-section-trigger"
		class="group flex w-full items-center justify-between rounded-md bg-[var(--color-bg-tertiary)] px-3 py-2 text-left font-medium text-muted-foreground text-sm transition-colors duration-snap hover:bg-[var(--color-bg-tertiary)]/80"
	>
		<span data-slot="queue-section-label" class="flex items-center gap-2">
			<CaretDown class="size-4 transition-transform duration-snap group-data-[state=closed]:-rotate-90" />
			{@render icon()}
			<span>{count} {label}</span>
		</span>
		{@render trailing?.()}
	</CollapsibleTrigger>
	<CollapsibleContent data-slot="queue-section-content">
		<ScrollArea data-slot="queue-list" class="mt-2 -mb-1">
			<div class="max-h-40 pr-4">
				<ul>
					{@render children()}
				</ul>
			</div>
		</ScrollArea>
		{@render footer?.()}
	</CollapsibleContent>
</Collapsible>
