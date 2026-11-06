<script lang="ts">
import { getActiveTurnId, getChatItems, isChatStreaming } from "$lib/chat/timeline.svelte";
import { approvePlanAction, rejectPlanAction, sendChatMessage } from "$lib/chat/turn.svelte";
import ToolCallCard from "$lib/components/agent-activity/ToolCallCard.svelte";
import { Dotmatrix, squareVariantForId } from "$lib/components/ui/dotmatrix/index.js";
import { gsapFadeY, tokens } from "$lib/motion";
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

const TOOL_CALL_ROW_H = 14; // px — the walkthrough's compact tool-call rows

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
						<div class="chat-tool-calls">
							{#each recentToolCalls as step, i (step.id)}
								<div
									class="chat-tool-call"
									style="top: {i * TOOL_CALL_ROW_H}px"
									in:gsapFadeY={{ y: TOOL_CALL_ROW_H, duration: tokens.smooth }}
									out:gsapFadeY={{ y: -TOOL_CALL_ROW_H, duration: tokens.quick }}
								>
									<span class="chat-tool-call-tool">{step.toolName}</span>
									<span class="chat-tool-call-desc">{step.summary}</span>
								</div>
							{/each}
						</div>
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
	}

	/* The live turn's last two tool calls, stacked; they slide up as new ones
	   arrive, like the walkthrough's tool-call rows. */
	.chat-tool-calls {
		position: relative;
		flex: 1;
		height: 28px; /* 2 × 14px rows — fixed to prevent layout shift */
		min-width: 0;
		overflow: hidden;
	}

	.chat-tool-call {
		position: absolute;
		left: 0;
		right: 0;
		display: flex;
		gap: 6px;
		min-width: 0;
		font-size: 10px;
		line-height: 14px;
		/* `top`, not a transform: the enter transition writes an inline
		   `transform`, and a base-class transform would compose with it. */
		transition: top var(--duration-smooth) var(--ease-standard);
	}

	.chat-tool-call-tool {
		color: var(--color-accent);
		font-weight: 500;
		flex-shrink: 0;
	}

	.chat-tool-call-desc {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		color: var(--color-text-muted);
	}
</style>
