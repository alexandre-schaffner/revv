<script lang="ts">
// What sits on top of the composer: the agent's proposed commits, its task
// list, and messages queued behind the running turn.
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import Circle from "phosphor-svelte/lib/Circle";
import PaperPlaneTilt from "phosphor-svelte/lib/PaperPlaneTilt";
import Spinner from "phosphor-svelte/lib/Spinner";
import X from "phosphor-svelte/lib/X";
import type { ProposedChanges } from "$lib/chat/api";
import { getQueuedMessages, removeQueuedMessage } from "$lib/chat/queue.svelte";
import { getActiveTasks } from "$lib/chat/timeline.svelte";
import { gsapFadeY, gsapSlide, tokens } from "$lib/motion";
import { cn } from "$lib/utils.js";
import ProposedCommits from "./proposed/ProposedCommits.svelte";
import QueueItem from "./queue/QueueItem.svelte";
import QueueItemAction from "./queue/QueueItemAction.svelte";
import QueueSection from "./queue/QueueSection.svelte";

interface Props {
  prId: string;
  proposed: ProposedChanges | null;
}

let { prId, proposed }: Props = $props();

const tasks = $derived(getActiveTasks(prId));
const completed = $derived(tasks.filter((t) => t.status === "completed").length);
const allDone = $derived(completed === tasks.length);
const queued = $derived(getQueuedMessages(prId));
</script>


<div
	data-slot="queue"
	data-glass
	class={cn(
		"flex flex-col gap-2 rounded-xl border border-border bg-background px-3 pt-2 pb-2 shadow-xs",
		"composer-glass rounded-t-xl rounded-b-none border-b-0 shadow-none",
	)}
>
	{#if proposed && proposed.commits.length > 0}
		<div transition:gsapSlide={{ duration: tokens.smooth }}>
			<ProposedCommits {prId} {proposed} />
		</div>
	{/if}

	{#if tasks.length > 0}
		<div transition:gsapSlide={{ duration: tokens.smooth }}>
			<QueueSection open={!allDone} label={tasks.length === 1 ? "todo" : "todos"} count={tasks.length}>
				{#snippet icon()}
					{#if tasks.some((t) => t.status === "in_progress")}
						<Spinner class="size-3 text-primary motion-essential-spin" />
					{:else if allDone}
						<CheckCircle class="size-3 text-success" />
					{:else}
						<Circle class="size-3 text-muted-foreground" />
					{/if}
				{/snippet}
				{#snippet trailing()}
					<span class="ml-auto text-xs tabular-nums text-muted-foreground">
						{completed}/{tasks.length}
					</span>
				{/snippet}
				{#each tasks as task, taskIdx (task.id)}
					{@const done = task.status === "completed"}
					<div
						in:gsapFadeY={{ y: 4, duration: tokens.quick, delay: Math.min(taskIdx, 8) * tokens.stagger.tight }}
						out:gsapFadeY={{ y: -4, duration: tokens.snap }}
					>
						<QueueItem>
							<span
								data-slot="queue-item-indicator"
								class={cn(
									"mt-0.5 inline-block size-2.5 shrink-0 rounded-full border",
									done ? "border-muted-foreground/20 bg-muted-foreground/10" : "border-muted-foreground/50",
								)}
							></span>
							<span
								data-slot="queue-item-content"
								class={cn(
									"line-clamp-1 grow break-words",
									done ? "text-muted-foreground/50 line-through" : "text-muted-foreground",
								)}
							>
								{#if task.status === "in_progress" && task.activeForm}
									{task.activeForm}
								{:else}
									{task.content}
								{/if}
							</span>
						</QueueItem>
					</div>
				{/each}
			</QueueSection>
		</div>
	{/if}

	{#if queued.length > 0}
		<div transition:gsapSlide={{ duration: tokens.smooth }}>
			<QueueSection
				label={queued.length === 1 ? "queued message" : "queued messages"}
				count={queued.length}
			>
				{#snippet icon()}
					<PaperPlaneTilt class="size-3 text-muted-foreground" />
				{/snippet}
				{#each queued as msg, msgIdx (msg.id)}
					<div
						in:gsapFadeY={{ y: 4, duration: tokens.quick, delay: Math.min(msgIdx, 8) * tokens.stagger.tight }}
						out:gsapFadeY={{ y: -4, duration: tokens.snap }}
					>
						<QueueItem>
							<span data-slot="queue-item-content" class="line-clamp-1 grow break-words text-muted-foreground">
								{msg.text}
							</span>
							<div data-slot="queue-item-actions" class="flex gap-1">
								<QueueItemAction
									onclick={() => removeQueuedMessage(prId, msg.id)}
									aria-label="Remove queued message"
								>
									<X class="size-3" />
								</QueueItemAction>
							</div>
						</QueueItem>
					</div>
				{/each}
			</QueueSection>
		</div>
	{/if}
</div>
