<script lang="ts" module>
import type { ChatSessionCommand } from "@revv/shared";
import type { HTMLAttributes } from "svelte/elements";

export type PromptInputTextareaProps = Omit<HTMLAttributes<HTMLDivElement>, "contenteditable"> & {
  /** Placeholder text. */
  placeholder?: string;
  commands?: readonly ChatSessionCommand[];
  mentionPaths?: readonly string[];
  /** When true the editor is read-only (no PR selected). */
  disabled?: boolean;
};
</script>

<script lang="ts">
	import { detectMentionTrigger, type MentionTrigger } from "@revv/shared";
	import { getContext } from "svelte";
	import { cn } from "$lib/utils.js";
	import { fileIcon } from "$lib/utils/file-icon";
	import {
		backwardPillTarget,
		caretTextBefore,
		deletePillBackward,
		deletePillForward,
		editorCaret,
		forwardNode,
		isPill,
		makePill,
		placeCaretAfter,
		render,
		replaceTokenRange,
		serialize,
	} from "./composer-editor-model";
	import { PROMPT_INPUT_CTX_KEY, type PromptInputContext } from "./context.js";
	import PromptInputAutocompleteMenu from "./PromptInputAutocompleteMenu.svelte";

	let {
		placeholder = "Type a message...",
		commands = [],
		mentionPaths = [],
		disabled = false,
		class: className,
		onfocus,
		...restProps
	}: PromptInputTextareaProps = $props();

	const ctx = getContext<PromptInputContext>(PROMPT_INPUT_CTX_KEY);
	let editorEl: HTMLDivElement | undefined = $state(undefined);
	let activeIndex = $state(0);
	// Set true on Escape to hide the menu without changing the text; reset on the
	// next keystroke so a fresh token reopens it.
	let dismissed = $state(false);
	// The active autocomplete trigger at the caret. Unlike a textarea we can't
	// derive this from a reactive value+selectionStart, so we recompute it
	// imperatively whenever the caret could have moved (input / key / pointer).
	let trigger = $state<MentionTrigger | null>(null);

	const mentionPathSet = $derived(new Set(mentionPaths));

	const slashItems = $derived.by(() => {
		if (trigger?.kind !== "slash") return [];
		const q = trigger.query.toLowerCase();
		return commands.filter((command) => command.name.toLowerCase().includes(q)).slice(0, 8);
	});

	const mentionItems = $derived.by(() => {
		if (trigger?.kind !== "mention") return [];
		const q = trigger.query.toLowerCase();
		return mentionPaths.filter((path) => path.toLowerCase().includes(q)).slice(0, 10);
	});

	const menuOpen = $derived(
		!dismissed &&
			((trigger?.kind === "slash" && slashItems.length > 0) ||
				(trigger?.kind === "mention" && mentionItems.length > 0)),
	);

	// Raw length, not trimmed: a value of just "\n" (Shift+Enter on an empty
	// editor) is non-empty, so the overlaid placeholder hides instead of sitting
	// on top of the live caret on line 2.
	const isEmpty = $derived(ctx.value.length === 0);

	$effect(() => {
		void trigger?.kind;
		void trigger?.query;
		activeIndex = 0;
	});

	// ── Mentions in the editor are atomic pills ──────────────────────────────
	// The editor is a contenteditable surface, NOT a textarea: a `@path` mention
	// is a real, non-editable pill node, while everything else is plain text.
	// `ctx.value` stays a flat string (the backend's contract) by serializing the
	// DOM — each pill back to its `@path` token — on every edit. The DOM algebra
	// (serialize/render/caret/pill-deletion) lives in `composer-editor-model.ts`;
	// this component keeps only the reactive glue.

	// Keep the editor DOM in step with programmatic value changes (the submit
	// clear, mainly). Skip when the DOM already serializes to `ctx.value` — i.e.
	// during normal typing — so we never stomp the caret mid-edit.
	$effect(() => {
		const v = ctx.value;
		if (!editorEl || v === serialize(editorEl)) return;
		render(editorEl, v, mentionPathSet);
	});

	function pushValue() {
		ctx.setValue(serialize(editorEl));
	}

	// ── Caret-relative trigger detection ─────────────────────────────────────
	// The last collapsed caret inside the editor. Saved on every interaction so
	// selecting an autocomplete row with the mouse — which would otherwise blur
	// the editor and drop the live selection — can still target the right spot.
	let savedRange: Range | null = null;

	function refreshTrigger() {
		const sel = window.getSelection();
		if (sel && sel.rangeCount > 0) {
			const range = sel.getRangeAt(0);
			if (range.collapsed && editorEl?.contains(range.startContainer)) {
				savedRange = range.cloneRange();
			}
		}
		trigger = editorEl ? detectMentionTrigger(caretTextBefore(editorEl, savedRange)) : null;
	}

	// ── Token replacement (autocomplete selection) ───────────────────────────
	function applyMention(path: string) {
		if (trigger?.kind !== "mention" || !editorEl) return;
		const r = replaceTokenRange(editorEl, savedRange, trigger.query.length + 1);
		if (!r) return;
		const space = document.createTextNode(" ");
		const pill = makePill(`@${path}`, path);
		r.insertNode(space);
		r.insertNode(pill);
		placeCaretAfter(space);
		closeMenuAfterInsert();
	}

	function applySlash(name: string) {
		if (trigger?.kind !== "slash" || !editorEl) return;
		const r = replaceTokenRange(editorEl, savedRange, trigger.query.length + 1);
		if (!r) return;
		const txt = document.createTextNode(`/${name} `);
		r.insertNode(txt);
		placeCaretAfter(txt);
		closeMenuAfterInsert();
	}

	function closeMenuAfterInsert() {
		pushValue();
		trigger = null;
		dismissed = true;
		editorEl?.focus();
	}

	function selectActive() {
		if (trigger?.kind === "slash") {
			const item = slashItems[activeIndex];
			if (item) applySlash(item.name);
		} else if (trigger?.kind === "mention") {
			const path = mentionItems[activeIndex];
			if (path) applyMention(path);
		}
	}

	function shortPath(path: string): string {
		if (path.length <= 58) return path;
		return `${path.slice(0, 24)}...${path.slice(-28)}`;
	}

	// Atomic pill deletion. WebKit otherwise needs two Backspaces on a
	// `contenteditable=false` node (the first only steps the caret over it), so
	// when a pill sits next to the caret we remove it ourselves in one press. The
	// model computes the target/plan; we execute it, then re-sync value + trigger
	// once at the end (shared by both directions).
	function deleteAdjacentPill(e: KeyboardEvent): boolean {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0 || !editorEl) return false;
		const range = sel.getRangeAt(0);
		if (!range.collapsed) return false;

		if (e.key === "Delete") {
			const pill = forwardNode(range);
			if (!isPill(pill)) return false;
			e.preventDefault();
			deletePillForward(editorEl, sel, pill);
		} else {
			const target = backwardPillTarget(range);
			if (!target) return false;
			e.preventDefault();
			deletePillBackward(editorEl, sel, target);
		}
		pushValue();
		refreshTrigger();
		return true;
	}

	function handleKeydown(e: KeyboardEvent) {
		if ((e.key === "Backspace" || e.key === "Delete") && !e.isComposing) {
			if (deleteAdjacentPill(e)) return;
		}
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
				e.preventDefault();
				dismissed = true;
				activeIndex = 0;
				return;
			}
			if (e.key === " ") activeIndex = 0;
		}
		if (e.key === "Enter" && !e.isComposing) {
			// Enter submits; Shift+Enter inserts a newline as a <br> so the
			// serializer sees a single, predictable break shape. `execCommand` is
			// deprecated but chosen deliberately: it preserves the native undo
			// stack that manual Range surgery would break. Don't "modernize" it.
			e.preventDefault();
			if (e.shiftKey) {
				document.execCommand("insertLineBreak");
			} else {
				ctx.submit();
			}
		}
	}

	function handleInput() {
		pushValue();
		dismissed = false;
		refreshTrigger();
	}

	// Pillify any complete, known mention typed by hand (rather than picked from
	// the menu) once the user leaves the field — a safe moment to rebuild the DOM
	// since there's no caret to disturb. Serialization is unchanged, so ctx.value
	// stays put.
	function handleBlur() {
		if (editorEl && ctx.value.trim().length > 0) render(editorEl, ctx.value, mentionPathSet);
	}

	// Always take over paste: insert the clipboard's plain text via `execCommand`
	// (deprecated but keeps the native undo stack; never injects HTML). We
	// `preventDefault()` unconditionally — including for image/rich pastes that
	// carry no `text/plain` — so WebKit can't drop an `<img>`/`<div>` ghost node
	// the serializer would silently ignore (DOM and `ctx.value` desyncing). File
	// attachments still reach the parent form's paste handler on the bubbled
	// event (preventDefault doesn't stop propagation).
	function handlePaste(e: ClipboardEvent) {
		e.preventDefault();
		const text = e.clipboardData?.getData("text/plain") ?? "";
		if (text) document.execCommand("insertText", false, text);
	}
</script>

{#snippet slashRow(item: ChatSessionCommand)}
	<span class="block font-mono text-xs">/{item.name}</span>
	<span class="block truncate text-xs text-muted-foreground">{item.description}</span>
{/snippet}

{#snippet mentionRow(path: string)}
	{@const icon = fileIcon(path)}
	<svg
		class="size-3.5 shrink-0"
		viewBox="0 0 16 16"
		style={icon.color ? `color: ${icon.color}` : undefined}
		aria-hidden="true"
	>
		<use href={`#${icon.symbolId}`} />
	</svg>
	<span class="min-w-0 truncate">{shortPath(path)}</span>
{/snippet}

{#if menuOpen && trigger?.kind === "slash"}
	<PromptInputAutocompleteMenu
		items={slashItems}
		{activeIndex}
		key={(item) => item.name}
		rowClass="block text-sm"
		onselect={(item) => applySlash(item.name)}
		row={slashRow}
	/>
{:else if menuOpen && trigger?.kind === "mention"}
	<PromptInputAutocompleteMenu
		items={mentionItems}
		{activeIndex}
		key={(path) => path}
		rowClass="flex items-center gap-2 font-mono text-xs"
		rowTitle={(path) => path}
		onselect={applyMention}
		row={mentionRow}
	/>
{/if}

<div class="pi-wrap">
	{#if isEmpty}
		<div class="pi-placeholder px-4 py-3 text-sm leading-relaxed" aria-hidden="true">
			{placeholder}
		</div>
	{/if}
	<div
		bind:this={editorEl}
		contenteditable={!disabled}
		role="textbox"
		tabindex="0"
		aria-multiline="true"
		aria-label={placeholder}
		data-slot="prompt-input-textarea"
		class={cn(
			"pi-editor block w-full min-h-[2.75rem] bg-transparent px-4 py-3 text-sm leading-relaxed text-foreground focus:outline-none",
			className,
		)}
		oninput={handleInput}
		onkeydown={handleKeydown}
		onkeyup={refreshTrigger}
		onmouseup={refreshTrigger}
		onpaste={handlePaste}
		onblur={handleBlur}
		onfocus={(e) => {
			refreshTrigger();
			onfocus?.(e);
		}}
		{...restProps}
	></div>
</div>

<style>
	.pi-wrap {
		position: relative;
	}
	.pi-editor {
		box-sizing: border-box;
		max-height: 160px;
		overflow-y: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.pi-placeholder {
		position: absolute;
		inset: 0;
		z-index: 0;
		pointer-events: none;
		user-select: none;
		color: var(--color-muted-foreground);
	}
	/* Atomic mention chip: a real, non-editable pill. Accent-tinted so it reads
	   as a token on the dark composer; the file glyph keeps its own color. */
	.pi-editor :global(.composer-pill) {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.05rem 0.35rem;
		margin: 0 1px;
		border-radius: 5px;
		border: 1px solid color-mix(in srgb, var(--color-accent) 35%, transparent);
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
		color: var(--color-accent);
		font-size: 0.8125em;
		line-height: 1.4;
		white-space: nowrap;
		user-select: none;
		vertical-align: baseline;
	}
	.pi-editor :global(.composer-pill-icon) {
		width: 0.85em;
		height: 0.85em;
		flex-shrink: 0;
	}
</style>
