<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";
	import type { MessageRole } from "./context.js";

	export type MessageProps = HTMLAttributes<HTMLDivElement> & {
		/** The role of the message sender. */
		from: MessageRole;
	};
</script>

<script lang="ts">
	import { setContext } from "svelte";
	import { cn } from "$lib/utils.js";
	import { MESSAGE_CTX_KEY, type MessageContext } from "./context.js";

	let {
		from,
		children,
		class: className,
		...restProps
	}: MessageProps = $props();

	const ctx: MessageContext = {
		get role() {
			return from;
		},
	};
	setContext(MESSAGE_CTX_KEY, ctx);
</script>

<div
	data-slot="message"
	data-role={from}
	class={cn(
		"flex w-full gap-3",
		from === "user" && "justify-end",
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</div>
