<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";
	import type { FileChangeStatus } from "./Commit.svelte";

	export type CommitFileProps = HTMLAttributes<HTMLDivElement> & {
		path: string;
		status: FileChangeStatus;
		additions?: number;
		deletions?: number;
		onclick?: () => void;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { FilePlus2, FileEdit, FileX2, FileSymlink } from "@lucide/svelte";
	import type { Component } from "svelte";

	let {
		path,
		status,
		additions,
		deletions,
		onclick,
		class: className,
		...restProps
	}: CommitFileProps = $props();

	const statusConfig: Record<FileChangeStatus, { icon: Component; color: string; label: string }> = {
		added: { icon: FilePlus2, color: "text-green-500", label: "A" },
		modified: { icon: FileEdit, color: "text-yellow-500", label: "M" },
		deleted: { icon: FileX2, color: "text-red-500", label: "D" },
		renamed: { icon: FileSymlink, color: "text-blue-500", label: "R" },
	};

	let config = $derived(statusConfig[status]);
	let StatusIcon = $derived(config.icon);
	let filename = $derived(path.split("/").pop() ?? path);
	let dir = $derived(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

	let sharedClass = $derived(cn(
		"flex items-center gap-2 px-3 py-1.5 text-xs",
		onclick && "cursor-pointer hover:bg-muted/50 transition-colors duration-snap",
		className,
	));
</script>

{#snippet fileContent()}
	<StatusIcon class={cn("size-3.5 shrink-0", config.color)} />
	<span class="flex-1 truncate font-mono">
		{#if dir}
			<span class="text-muted-foreground">{dir}/</span>
		{/if}
		<span class="text-foreground">{filename}</span>
	</span>
	{#if additions !== undefined || deletions !== undefined}
		<span class="flex items-center gap-1 shrink-0 font-mono">
			{#if additions !== undefined && additions > 0}
				<span class="text-green-500">+{additions}</span>
			{/if}
			{#if deletions !== undefined && deletions > 0}
				<span class="text-red-500">-{deletions}</span>
			{/if}
		</span>
	{/if}
{/snippet}

{#if onclick}
	<button
		data-slot="commit-file"
		type="button"
		class={sharedClass}
		{onclick}
	>
		{@render fileContent()}
	</button>
{:else}
	<div
		data-slot="commit-file"
		class={sharedClass}
		{...restProps}
	>
		{@render fileContent()}
	</div>
{/if}
