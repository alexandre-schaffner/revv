<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";

	export type ConfirmationProps = HTMLAttributes<HTMLDivElement> & {
		/** The tool or action being confirmed. */
		tool: string;
		/** The confirmation message/description. */
		message?: string | undefined;
		/** Whether the confirmation has been responded to. */
		responded?: boolean;
		/** Callback when the user approves. */
		onApprove?: () => void;
		/** Callback when the user denies. */
		onDeny?: () => void;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		tool,
		message,
		responded = false,
		onApprove,
		onDeny,
		children,
		class: className,
		...restProps
	}: ConfirmationProps = $props();
</script>

<div
	data-slot="confirmation"
	data-responded={responded || undefined}
	class={cn(
		"rounded-lg border border-border bg-background",
		responded && "opacity-60",
		className,
	)}
	role="alertdialog"
	aria-label="Confirm action: {tool}"
	{...restProps}
>
	{@render children?.()}
</div>
