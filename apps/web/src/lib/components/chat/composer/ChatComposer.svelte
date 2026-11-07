<script lang="ts">
// The message box: text with `/` command and `@` file completion, file
// attachments (checked when added), the plan-mode toggle, and send / stop.
import ArrowUp from "phosphor-svelte/lib/ArrowUp";
import MapTrifold from "phosphor-svelte/lib/MapTrifold";
import Paperclip from "phosphor-svelte/lib/Paperclip";
import Stop from "phosphor-svelte/lib/Stop";
import { toast } from "svelte-sonner";
import { admitAttachments, encodeAttachments, type PendingAttachment } from "$lib/chat/attachments";
import {
  getChatMentionPaths,
  getChatSessionContext,
  isPlanModeAvailable,
  warmChatSessionContext,
} from "$lib/chat/session.svelte";
import { getInteractionMode, isChatStreaming } from "$lib/chat/timeline.svelte";
import { abortChatTurn, setInteractionMode, submitChatMessage } from "$lib/chat/turn.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { gsapFadeY, tokens } from "$lib/motion";
import { getChangedPaths } from "$lib/stores/diff-files.svelte";
import { cn } from "$lib/utils.js";
import AttachmentChip from "../AttachmentChip.svelte";
import ComposerButton from "./ComposerButton.svelte";
import ComposerEditor from "./ComposerEditor.svelte";

interface Props {
  prId: string;
  /** The queue dock sits on top: square the top edge to join it. */
  attached: boolean;
}

let { prId, attached }: Props = $props();

let value = $state("");
let attachments = $state<PendingAttachment[]>([]);
let dragActive = $state(false);
let editor: ComposerEditor | undefined = $state();
let fileInput: HTMLInputElement | undefined = $state();

const isStreaming = $derived(isChatStreaming(prId));
const interactionMode = $derived(getInteractionMode(prId));
const planModeAvailable = $derived(isPlanModeAvailable());
const commands = $derived(getChatSessionContext(prId)?.commands ?? []);
const mentionPaths = $derived(getChatMentionPaths(prId, getChangedPaths(prId)));
const isEmpty = $derived(value.trim().length === 0 && attachments.length === 0);

export function focus(): void {
  editor?.focus();
}

function addFiles(files: readonly File[]): number {
  if (files.length === 0) return 0;
  const { admitted, rejections } = admitAttachments(attachments, files);
  for (const message of rejections) toast.error(message);
  if (admitted.length > 0) attachments = [...attachments, ...admitted];
  return admitted.length;
}

let encoding = false;

/** The text and attachments leave the box only once the attachments are read. */
async function submit(): Promise<void> {
  const text = value.trim();
  const picked = attachments;
  if ((!text && picked.length === 0) || encoding) return;
  encoding = true;
  try {
    const encoded = await encodeAttachments(picked);
    if (value.trim() === text) value = "";
    attachments = attachments.filter((a) => !picked.includes(a));
    submitChatMessage(prId, text, encoded);
  } catch (e) {
    toast.error(
      e instanceof Error
        ? `Couldn't read an attachment: ${e.message}`
        : "Couldn't read an attachment",
    );
  } finally {
    encoding = false;
  }
}

// The button stops a running turn; Enter in the editor always sends (queued
// behind the running turn).
function handleFormSubmit(e: SubmitEvent): void {
  e.preventDefault();
  if (isStreaming) {
    abortChatTurn(prId);
  } else {
    void submit();
  }
}

function handleDragOver(e: DragEvent): void {
  if (!e.dataTransfer || Array.from(e.dataTransfer.items).every((item) => item.kind !== "file")) {
    return;
  }
  e.preventDefault();
  dragActive = true;
}

function handleDrop(e: DragEvent): void {
  const dropped = Array.from(e.dataTransfer?.files ?? []);
  if (dropped.length === 0) return;
  e.preventDefault();
  dragActive = false;
  const added = addFiles(dropped);
  if (added > 0) toast.message(added === 1 ? "Attached file" : "Attached files");
}

function togglePlanMode(): void {
  if (!planModeAvailable) return;
  void setInteractionMode(prId, interactionMode === "plan" ? "default" : "plan");
}
</script>

<form
	data-slot="prompt-input"
	data-glass
	class={cn(
		"relative flex flex-col rounded-xl border border-border bg-background shadow-xs",
		dragActive && "border-accent shadow-sm shadow-accent/20",
		"composer-glass composer-glass-input transition-[border-color,box-shadow] duration-quick ease-out-expo" +
			(attached ? " composer-glass--attached rounded-t-none border-t-0" : ""),
	)}
	onsubmit={handleFormSubmit}
	onpaste={(e) => addFiles(Array.from(e.clipboardData?.files ?? []))}
	ondragover={handleDragOver}
	ondragleave={(e) => {
		if (e.currentTarget === e.target) dragActive = false;
	}}
	ondrop={handleDrop}
>
	<div data-slot="prompt-input-body" class="relative">
		{#if attachments.length > 0}
			<div class="flex flex-wrap gap-1.5 px-3 pt-2">
				{#each attachments as attachment, index (`${attachment.file.name}-${attachment.file.size}-${index}`)}
					<div
						in:gsapFadeY={{ y: 3, duration: tokens.quick }}
						out:gsapFadeY={{ y: -3, duration: tokens.snap }}
					>
						<AttachmentChip
							kind={attachment.kind}
							name={attachment.file.name}
							size={attachment.file.size}
							onRemove={() => (attachments = attachments.filter((_, i) => i !== index))}
						/>
					</div>
				{/each}
			</div>
		{/if}
		<ComposerEditor
			bind:this={editor}
			bind:value
			placeholder="Ask anything…"
			{commands}
			{mentionPaths}
			onsubmit={() => void submit()}
			onfocus={() => warmChatSessionContext(prId)}
		/>
	</div>
	<div data-slot="prompt-input-footer" class="flex items-center justify-between gap-2 px-3 pb-2">
		<div data-slot="prompt-input-tools" class="flex items-center gap-1">
			<ComposerButton tooltip="Attach files" onclick={() => fileInput?.click()} aria-label="Attach files">
				<Paperclip class="size-3.5" />
			</ComposerButton>
			<input
				bind:this={fileInput}
				type="file"
				multiple
				class="sr-only"
				tabindex="-1"
				onchange={(e) => {
					addFiles(Array.from(e.currentTarget.files ?? []));
					e.currentTarget.value = "";
				}}
			/>
			<ComposerButton
				tooltip={planModeAvailable
					? interactionMode === "plan"
						? "Plan mode is on. The agent will propose a plan instead of editing. Click to disable."
						: "Enable plan mode: ask the agent to propose a plan first."
					: "The selected agent doesn't offer plan mode."}
				onclick={togglePlanMode}
				disabled={!planModeAvailable}
				aria-pressed={interactionMode === "plan"}
				class={interactionMode === "plan" ? "bg-accent/15 text-accent hover:bg-accent/25 hover:text-accent" : ""}
			>
				<MapTrifold class="size-3.5" />
				{#if interactionMode === "plan"}
					<span class="text-xs font-medium">Plan</span>
				{/if}
			</ComposerButton>
		</div>
		<Button
			data-slot="prompt-input-submit"
			type="submit"
			size="icon-sm"
			variant={isStreaming ? "outline" : "default"}
			class="shrink-0"
			disabled={!isStreaming && isEmpty}
			aria-label={isStreaming ? "Stop" : "Send"}
		>
			{#if isStreaming}
				<Stop class="size-3" />
			{:else}
				<ArrowUp class="size-3.5" />
			{/if}
		</Button>
	</div>
</form>
