<script lang="ts">
import { getActiveTurnId, getChatItems, isChatStreaming } from "$lib/chat/timeline.svelte";
import { approvePlanAction, rejectPlanAction, sendChatMessage } from "$lib/chat/turn.svelte";
import ToolCallCard from "$lib/components/agent-activity/ToolCallCard.svelte";
import ToolCallTicker from "$lib/components/agent-activity/ToolCallTicker.svelte";
import { Dotmatrix, squareVariantForId } from "$lib/components/ui/dotmatrix/index.js";
import { cn } from "$lib/utils.js";
import ChatEmptyState from "./ChatEmptyState.svelte";
import ChatMessage from "./ChatMessage.svelte";
import Conversation from "./Conversation.svelte";
import PlanCard from "./PlanCard.svelte";
import StreamingVerb from "./StreamingVerb.svelte";

interface Props {
  prId: string | null;
  /** The panel covers the main pane: cap the conversation to a readable column. */
  stacked: boolean;
  /** Room left under the content for the floating composer. */
  bottomInset: number;
}

let { prId, stacked, bottomInset }: Props = $props();

const items = $derived(prId ? getChatItems(prId) : []);
const isStreaming = $derived(prId ? isChatStreaming(prId) : false);
// The live turn's tool calls fold into the dot-matrix ticker; they take their
// place in the timeline once the turn ends.
const activeTurnId = $derived(prId ? getActiveTurnId(prId) : null);
const recentToolCalls = $derived(
  activeTurnId
    ? items
        .filter(
          (i): i is Extract<typeof i, { kind: "activity" }> =>
            i.kind === "activity" && i.turnId === activeTurnId,
        )
        .slice(-2)
        .map((step) => ({ key: step.id, label: step.toolName, detail: step.summary }))
    : [],
);
</script>

<Conversation resetKey={prId}>
	{#if items.length === 0}
		<ChatEmptyState
			{prId}
			{stacked}
			{bottomInset}
			onSelect={(message) => {
				if (prId && !isStreaming) sendChatMessage({ prId, message });
			}}
		/>
	{:else}
		<div
			data-slot="conversation-content"
			class={cn(
				"flex flex-col gap-4 px-4 py-4",
				stacked ? "mx-auto w-full max-w-3xl gap-3 px-3.5 pt-3" : "gap-3 px-3.5 pt-3",
			)}
			role="log"
			aria-live="polite"
			style="padding-bottom: calc({bottomInset}px + 1rem)"
		>
			{#each items as item (item.id)}
				{#if item.kind === "activity"}
					{#if !(item.turnId && item.turnId === activeTurnId)}
						<ToolCallCard
							activityKind={item.activityKind}
							toolName={item.toolName}
							summary={item.summary}
							payload={item.payload}
							output={item.output}
							isError={item.isError}
						/>
					{/if}
				{:else if item.kind === "plan"}
					<PlanCard
						markdown={item.markdown}
						status={item.status}
						disabled={isStreaming}
						onApprove={() => prId && approvePlanAction(prId, item.id)}
						onReject={() => prId && rejectPlanAction(prId, item.id)}
					/>
				{:else if item.kind === "message"}
					<ChatMessage from={item.role} content={item.content} attachments={item.attachments} />
				{/if}
			{/each}

			{#if isStreaming}
				<div class="streaming-indicator" aria-label="AI is thinking…">
					{#if activeTurnId}
						<Dotmatrix variant={squareVariantForId(activeTurnId)} size="small" />
					{/if}
					{#if recentToolCalls.length > 0}
						<ToolCallTicker rows={recentToolCalls} />
					{:else}
						<StreamingVerb />
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</Conversation>

<style>
	.streaming-indicator {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		padding: 10px 14px;
		font-size: 10px;
	}
</style>
