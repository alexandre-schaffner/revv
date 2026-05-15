<script lang="ts" module>
	import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

	export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

	export type CommitFile = {
		path: string;
		status: FileChangeStatus;
		additions?: number;
		deletions?: number;
	};

	export type CommitProps = CollapsiblePrimitive.RootProps & {
		/** The short commit SHA. */
		sha?: string;
		/** The commit message (first line). */
		message?: string;
		/** The list of changed files. */
		files?: CommitFile[];
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { Collapsible } from "$lib/components/ui/collapsible/index.js";

	let {
		sha,
		message,
		files = [],
		open = $bindable(false),
		children,
		class: className,
		...restProps
	}: CommitProps = $props();
</script>

<Collapsible
	data-slot="commit"
	class={cn("rounded-lg border border-border bg-background", className)}
	bind:open
	{...restProps}
>
	{@render children?.()}
</Collapsible>
