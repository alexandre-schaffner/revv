<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;
</script>

<script lang="ts">
	import { getContext } from "svelte";
	import { cn } from "$lib/utils.js";
	import { MESSAGE_CTX_KEY, type MessageContext } from "./context.js";

	let {
		children,
		class: className,
		...restProps
	}: MessageContentProps = $props();

	const ctx = getContext<MessageContext>(MESSAGE_CTX_KEY);
</script>

<div
	data-slot="message-content"
	class={cn(
		"flex min-w-0 max-w-[85%] flex-col gap-1",
		ctx?.role === "user"
			? "items-end"
			: "items-start w-full max-w-none",
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</div>
