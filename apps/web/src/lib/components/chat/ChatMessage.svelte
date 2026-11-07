<script lang="ts">
import type { ChatAttachmentMetadata } from "@revv/shared";
import { cn } from "$lib/utils.js";
import AttachmentChip from "./AttachmentChip.svelte";
import MessageResponse from "./MessageResponse.svelte";

interface Props {
  prId: string;
  from: "user" | "assistant";
  content: string;
  attachments?: ReadonlyArray<ChatAttachmentMetadata> | undefined;
}

let { prId, from, content, attachments = [] }: Props = $props();
</script>

<div
	data-slot="message"
	data-role={from}
	class={cn("flex w-full gap-3", from === "user" && "justify-end")}
>
	<div
		data-slot="message-content"
		class={cn(
			"flex min-w-0 max-w-[85%] flex-col gap-1",
			from === "user" ? "items-end" : "items-start w-full max-w-none",
		)}
	>
		{#if from === "user"}
			<div class="flex max-w-full flex-col items-end gap-1.5">
				{#if content}
					<MessageResponse
						{prId}
						{from}
						{content}
						class="prose-user-bubble rounded-[14px] rounded-br-[4px] border border-user-bubble-border bg-user-bubble px-3 py-2"
					/>
				{/if}
				{#if attachments.length > 0}
					<div class="flex max-w-[min(26rem,80vw)] flex-wrap justify-end gap-1">
						{#each attachments as attachment, index (`${attachment.name}-${attachment.size}-${index}`)}
							<AttachmentChip
								kind={attachment.kind}
								name={attachment.name}
								size={attachment.size}
								tone="accent"
							/>
						{/each}
					</div>
				{/if}
			</div>
		{:else if content}
			<MessageResponse {prId} {from} {content} class="w-full" />
		{/if}
	</div>
</div>
