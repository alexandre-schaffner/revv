<script lang="ts">
// The chat with the agent about the selected PR: header, timeline, and the
// floating composer with the queue dock on top of it.
import { tick } from "svelte";
import {
  getProposedChanges,
  getWorktreeBlocked,
  resolveAndPushProposed,
} from "$lib/chat/proposed.svelte";
import { getQueuedMessages } from "$lib/chat/queue.svelte";
import { loadPlanModeAvailability } from "$lib/chat/session.svelte";
import { getActiveTasks, getChatItems } from "$lib/chat/timeline.svelte";
import { openChat } from "$lib/chat/turn.svelte";
import { provideActivityPr } from "$lib/components/agent-activity/repo-file";
import { gsapSlide, tokens } from "$lib/motion";
import { useCommands } from "$lib/stores/commands.svelte";
import { getSelectedPr, getSelectedPrId } from "$lib/stores/prs.svelte";
import { getChatStacked, setRightPanelOpen, toggleRightPanel } from "$lib/stores/sidebar.svelte";
import ChatTimeline from "./ChatTimeline.svelte";
import ChatComposer from "./composer/ChatComposer.svelte";
import BlockedStrip from "./header/BlockedStrip.svelte";
import ChatHeader from "./header/ChatHeader.svelte";
import PushConflictDialog from "./header/PushConflictDialog.svelte";
import QueueDock from "./QueueDock.svelte";

const prId = $derived(getSelectedPrId());
const pr = $derived(getSelectedPr());
// Too narrow to sit beside the main pane, the panel covers it instead.
const stacked = $derived(getChatStacked());

const hasItems = $derived(prId ? getChatItems(prId).length > 0 : false);
const proposed = $derived(prId ? getProposedChanges(prId) : null);
const commitCount = $derived(proposed?.commits.length ?? 0);
const blocked = $derived(prId ? getWorktreeBlocked(prId) : null);
const showQueueDock = $derived(
  prId !== null &&
    (getQueuedMessages(prId).length > 0 || getActiveTasks(prId).length > 0 || commitCount > 0),
);

let conflict = $state<{ files: string[]; branch: string } | null>(null);
let composer: ChatComposer | undefined = $state();

provideActivityPr(() => prId);

$effect(() => {
  if (prId) openChat(prId);
});

$effect(() => {
  loadPlanModeAvailability();
});

useCommands([
  {
    id: "chat:focus",
    label: "Focus Chat",
    keys: { key: "l" },
    when: () => prId !== null,
    hidden: true,
    run: async () => {
      setRightPanelOpen(true);
      await tick();
      composer?.focus();
    },
  },
]);

// The timeline keeps this much room under its last row so it can scroll
// clear of the floating composer, whose height follows the dock and the text.
let composerEl: HTMLDivElement | null = $state(null);
let composerH = $state(0);
$effect(() => {
  if (!composerEl) return;
  const ro = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (entry) composerH = entry.contentRect.height;
  });
  ro.observe(composerEl);
  return () => ro.disconnect();
});
</script>

<div class="panel" class:panel--stacked={stacked}>
	<ChatHeader
		{prId}
		{pr}
		{commitCount}
		{hasItems}
		{stacked}
		onClose={toggleRightPanel}
		onConflict={(next) => (conflict = next)}
	/>

	{#if prId && blocked}
		<BlockedStrip {prId} {blocked} />
	{/if}

	<ChatTimeline {prId} {stacked} bottomInset={composerH} />

	<div class="composer-float" bind:this={composerEl}>
		{#if prId && showQueueDock}
			<div class="queue-dock" transition:gsapSlide={{ duration: tokens.smooth }}>
				<QueueDock {prId} {proposed} />
			</div>
		{/if}
		<div>
			<ChatComposer bind:this={composer} {prId} attached={showQueueDock} />
		</div>
	</div>
</div>

<PushConflictDialog
	{conflict}
	onClose={() => (conflict = null)}
	onResolve={() => {
		conflict = null;
		if (prId) void resolveAndPushProposed(prId);
	}}
/>

<style>
	.panel {
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--color-panel-bg);
		overflow: hidden;
	}

	/* The queue dock and the input float over the conversation as one panel. */
	.composer-float {
		position: absolute;
		left: 10px;
		right: 10px;
		bottom: 10px;
		z-index: 4;
		display: flex;
		flex-direction: column;
		pointer-events: none;
	}

	.composer-float > :global(*) {
		pointer-events: auto;
	}

	/* Under the conversation's capped column (max-w-3xl = 48rem). */
	.panel--stacked .composer-float {
		left: 50%;
		right: auto;
		width: min(48rem, 100% - 20px);
		transform: translateX(-50%);
	}

	.queue-dock {
		display: flex;
		flex-direction: column;
	}

	/* Standing-chrome glass: 10px blur is the cap; 16px is for short-lived
	   overlays (dialogs, popovers, command palette). */
	:global(.composer-glass) {
		background: color-mix(in srgb, var(--color-panel-bg) 88%, transparent);
		backdrop-filter: blur(10px) saturate(1.4);
		-webkit-backdrop-filter: blur(10px) saturate(1.4);
		border-color: var(--color-glass-border);
		box-shadow:
			var(--color-glass-shadow),
			inset 0 0.5px 0 0 var(--color-glass-highlight);
	}

	/* Focus ring layered on top of the glass shadow, not replacing it. */
	:global(.composer-glass-input:focus-within) {
		border-color: color-mix(in srgb, var(--color-accent) 70%, transparent);
		box-shadow:
			0 0 0 3px color-mix(in srgb, var(--color-accent) 14%, transparent),
			var(--color-glass-shadow),
			inset 0 0.5px 0 0 var(--color-glass-highlight);
	}

	:global(.composer-glass-input:hover:not(:focus-within):not(:has(:disabled))) {
		border-color: var(--color-border-hover);
	}

	/* Joined under the queue dock: no top highlight, so the seam reads as one
	   surface. */
	:global(.composer-glass--attached) {
		box-shadow: var(--color-glass-shadow);
	}

	:global(.composer-glass--attached.composer-glass-input:focus-within) {
		box-shadow:
			0 0 0 3px color-mix(in srgb, var(--color-accent) 14%, transparent),
			var(--color-glass-shadow);
	}
</style>
