<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";

	export type ConfirmationActionsProps = HTMLAttributes<HTMLDivElement> & {
		/** Whether the confirmation has already been responded to. */
		responded?: boolean;
		/** Callback when the user approves. */
		onApprove?: () => void;
		/** Callback when the user denies. */
		onDeny?: () => void;
		/** Label for the approve button. */
		approveLabel?: string;
		/** Label for the deny button. */
		denyLabel?: string;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import { Check, X } from "@lucide/svelte";

	let {
		responded = false,
		onApprove,
		onDeny,
		approveLabel = "Allow",
		denyLabel = "Deny",
		children,
		class: className,
		...restProps
	}: ConfirmationActionsProps = $props();
</script>

<div
	data-slot="confirmation-actions"
	class={cn("flex items-center justify-end gap-2 border-t border-border px-3 py-2", className)}
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else}
		<Button
			variant="ghost"
			size="sm"
			disabled={responded}
			onclick={() => onDeny?.()}
		>
			<X data-icon="inline-start" />
			{denyLabel}
		</Button>
		<Button
			variant="default"
			size="sm"
			disabled={responded}
			onclick={() => onApprove?.()}
		>
			<Check data-icon="inline-start" />
			{approveLabel}
		</Button>
	{/if}
</div>
