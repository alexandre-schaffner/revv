<script lang="ts" module>
import type { ButtonProps } from "$lib/components/ui/button/index.js";

export type ConversationScrollButtonProps = ButtonProps;
</script>

<script lang="ts">
	import { getContext } from "svelte";
	import { cn } from "$lib/utils.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import { ArrowDown } from "@lucide/svelte";
	import { CONVERSATION_CTX_KEY, type ConversationContext } from "./context.js";

	let {
		class: className,
		...restProps
	}: ConversationScrollButtonProps = $props();

	const ctx = getContext<ConversationContext>(CONVERSATION_CTX_KEY);
</script>

{#if !ctx.isAtBottom}
	<div class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-4">
		<Button
			data-slot="conversation-scroll-button"
			variant="outline"
			size="icon-sm"
			class={cn(
				"pointer-events-auto rounded-full shadow-md",
				className,
			)}
			onclick={() => ctx.scrollToBottom()}
			aria-label="Scroll to bottom"
			{...restProps}
		>
			<ArrowDown class="size-3.5" />
		</Button>
	</div>
{/if}
