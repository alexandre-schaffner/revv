<script lang="ts" module>
import type { HTMLTextareaAttributes } from "svelte/elements";

export interface PromptInputCommand {
  readonly name: string;
  readonly description: string;
}

export type PromptInputTextareaProps = HTMLTextareaAttributes & {
  /** Placeholder text. */
  placeholder?: string;
  commands?: readonly PromptInputCommand[];
  mentionPaths?: readonly string[];
};
</script>

<script lang="ts">
	import { detectMentionTrigger, type MentionTrigger } from "@revv/shared";
	import { cn } from "$lib/utils.js";
	import { getContext } from "svelte";
	import { PROMPT_INPUT_CTX_KEY, type PromptInputContext } from "./context.js";
	import PromptInputMentionMenu from "./PromptInputMentionMenu.svelte";
	import PromptInputSlashMenu from "./PromptInputSlashMenu.svelte";

	let {
		placeholder = "Type a message...",
		commands = [],
		mentionPaths = [],
		class: className,
		...restProps
	}: PromptInputTextareaProps = $props();

	const ctx = getContext<PromptInputContext>(PROMPT_INPUT_CTX_KEY);
	let textareaEl: HTMLTextAreaElement | undefined = $state(undefined);
	let activeIndex = $state(0);
	// Set true on Escape to hide the menu without changing the text; reset
	// whenever the trigger token changes (see the activeIndex effect below).
	let dismissed = $state(false);

	const trigger = $derived.by<MentionTrigger | null>(() => {
		const value = ctx.value;
		// NOTE: `selectionStart` is read but is NOT reactive, so a caret-only
		// move (arrow keys / clicking into an existing `@token`) does not
		// re-evaluate the trigger and won't reopen the menu. This is by design —
		// the menu opens while typing the token; editing the text re-triggers.
		const caret = textareaEl?.selectionStart ?? value.length;
		return detectMentionTrigger(value.slice(0, caret));
	});

	const slashItems = $derived.by(() => {
		if (trigger?.kind !== "slash") return [];
		const q = trigger.query.toLowerCase();
		return commands
			.filter((command) => command.name.toLowerCase().includes(q))
			.slice(0, 8);
	});

	const mentionItems = $derived.by(() => {
		if (trigger?.kind !== "mention") return [];
		const q = trigger.query.toLowerCase();
		return mentionPaths
			.filter((path) => path.toLowerCase().includes(q))
			.slice(0, 10);
	});

	const menuOpen = $derived(
		!dismissed &&
			((trigger?.kind === "slash" && slashItems.length > 0) ||
				(trigger?.kind === "mention" && mentionItems.length > 0)),
	);

	$effect(() => {
		void trigger?.kind;
		void trigger?.query;
		activeIndex = 0;
		dismissed = false;
	});

	function replaceToken(replacement: string) {
		if (!trigger || !textareaEl) return;
		const caret = textareaEl.selectionStart;
		const before = ctx.value.slice(0, trigger.start);
		const after = ctx.value.slice(caret);
		const next = `${before}${replacement}${after}`;
		ctx.setValue(next);
		const nextCaret = before.length + replacement.length;
		requestAnimationFrame(() => {
			textareaEl?.focus();
			textareaEl?.setSelectionRange(nextCaret, nextCaret);
		});
	}

	function selectActive() {
		if (trigger?.kind === "slash") {
			const item = slashItems[activeIndex];
			if (item) replaceToken(`/${item.name} `);
		} else if (trigger?.kind === "mention") {
			const item = mentionItems[activeIndex];
			if (item) replaceToken(`@${item} `);
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (menuOpen) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				const max = trigger?.kind === "slash" ? slashItems.length : mentionItems.length;
				activeIndex = Math.min(activeIndex + 1, Math.max(0, max - 1));
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				activeIndex = Math.max(0, activeIndex - 1);
				return;
			}
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				selectActive();
				return;
			}
			if (e.key === "Escape") {
				// Dismiss the menu without mutating the text or submitting.
				e.preventDefault();
				dismissed = true;
				activeIndex = 0;
				return;
			}
			if (e.key === " ") {
				activeIndex = 0;
			}
		}
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			ctx.submit();
		}
	}

	function autoResize() {
		if (!textareaEl) return;
		// Empty: defer to CSS min-height. Measuring scrollHeight during the
		// first layout pass of the floating composer can latch oversized.
		if (!ctx.value) {
			textareaEl.style.height = "";
			return;
		}
		textareaEl.style.height = "auto";
		textareaEl.style.height = Math.min(textareaEl.scrollHeight, 160) + "px";
	}

	$effect(() => {
		// Track ctx.value so autoResize fires on programmatic clear/fill.
		void ctx.value;
		autoResize();
	});
</script>

{#if menuOpen && trigger?.kind === "slash"}
	<PromptInputSlashMenu
		items={slashItems}
		{activeIndex}
		onselect={(item) => replaceToken(`/${item.name} `)}
	/>
{:else if menuOpen && trigger?.kind === "mention"}
	<PromptInputMentionMenu
		paths={mentionItems}
		{activeIndex}
		onselect={(path) => replaceToken(`@${path} `)}
	/>
{/if}

<textarea
	bind:this={textareaEl}
	value={ctx.value}
	oninput={(e) => {
		ctx.setValue(e.currentTarget.value);
		autoResize();
	}}
	data-slot="prompt-input-textarea"
	class={cn(
		"block w-full min-h-[2.75rem] resize-none bg-transparent px-4 py-3 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none",
		className,
	)}
	{placeholder}
	rows={1}
	onkeydown={handleKeydown}
	{...restProps}
></textarea>
