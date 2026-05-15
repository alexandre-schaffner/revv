<script lang="ts" module>
	import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

	export type CommitHeaderProps = CollapsiblePrimitive.TriggerProps & {
		sha?: string;
		message?: string;
		fileCount?: number;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { CollapsibleTrigger } from "$lib/components/ui/collapsible/index.js";
	import { ChevronRight, GitCommitHorizontal } from "@lucide/svelte";

	let {
		sha,
		message,
		fileCount,
		children,
		class: className,
		...restProps
	}: CommitHeaderProps = $props();
</script>

<CollapsibleTrigger
	data-slot="commit-header"
	class={cn(
		"flex w-full items-center gap-2 px-3 py-2.5 text-sm transition-colors duration-snap hover:bg-muted/50",
		className,
	)}
	{...restProps}
>
	<ChevronRight class="size-3.5 shrink-0 text-muted-foreground transition-transform duration-snap [[data-state=open]_&]:rotate-90" />
	<GitCommitHorizontal class="size-3.5 shrink-0 text-muted-foreground" />
	{#if sha}
		<code class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">{sha.slice(0, 7)}</code>
	{/if}
	<span class="flex-1 truncate text-left font-medium">{message ?? "Commit"}</span>
	{#if fileCount !== undefined}
		<span class="shrink-0 text-xs text-muted-foreground">{fileCount} file{fileCount === 1 ? "" : "s"}</span>
	{/if}
	{@render children?.()}
</CollapsibleTrigger>
