<script lang="ts" module>
import type { ChatSessionCommand } from "@revv/shared";
import type { HTMLTextareaAttributes } from "svelte/elements";

export type PromptInputTextareaProps = HTMLTextareaAttributes & {
  /** Placeholder text. */
  placeholder?: string;
  commands?: readonly ChatSessionCommand[];
  mentionPaths?: readonly string[];
};
</script>

<script lang="ts">
	import { detectMentionTrigger, type MentionTrigger } from "@revv/shared";
	import { cn } from "$lib/utils.js";
	import { fileIcon } from "$lib/utils/file-icon";
	import { getContext } from "svelte";
	import { PROMPT_INPUT_CTX_KEY, type PromptInputContext } from "./context.js";
	import PromptInputAutocompleteMenu from "./PromptInputAutocompleteMenu.svelte";

	let {
		placeholder = "Type a message...",
		commands = [],
		mentionPaths = [],
		class: className,
		...restProps
	}: PromptInputTextareaProps = $props();

	const ctx = getContext<PromptInputContext>(PROMPT_INPUT_CTX_KEY);
	let textareaEl: HTMLTextAreaElement | undefined = $state(undefined);
	let overlayEl: HTMLDivElement | undefined = $state(undefined);
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
	});

	function replaceToken(replacement: string) {
		if (!trigger || !textareaEl) return;
		const caret = textareaEl.selectionStart;
		const before = ctx.value.slice(0, trigger.start);
		const after = ctx.value.slice(caret);
		const next = `${before}${replacement}${after}`;
		ctx.setValue(next);
		// Close the menu. The token is now complete and the caret moves past it,
		// but `selectionStart` is non-reactive so the trigger re-derives against
		// the stale caret (still inside the token) and would otherwise keep the
		// menu open. Dismiss explicitly; the next real keystroke (`oninput`)
		// clears it so a fresh token reopens the menu.
		dismissed = true;
		const nextCaret = before.length + replacement.length;
		requestAnimationFrame(() => {
			textareaEl?.focus();
			textareaEl?.setSelectionRange(nextCaret, nextCaret);
		});
	}

	// Single source for the inserted-token format, shared by the keyboard
	// (`selectActive`) and mouse (`onselect`) paths so the marker + trailing
	// space convention lives in exactly one place per kind.
	function applySlash(name: string) {
		replaceToken(`/${name} `);
	}
	function applyMention(path: string) {
		replaceToken(`@${path} `);
	}

	function shortPath(path: string): string {
		if (path.length <= 58) return path;
		return `${path.slice(0, 24)}...${path.slice(-28)}`;
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

	// ── Mention highlight overlay ────────────────────────────────────────────
	// A textarea can't render inline pills, so we mirror its text in an overlay
	// behind transparent textarea text and style the `@path` tokens there. The
	// overlay shares the textarea's exact box + typography so glyphs line up; the
	// pill carries no horizontal padding (a box-shadow halo fakes the breathing
	// room) so it never shifts the text the caret is editing.
	const MENTION_RE = /@((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+)(?::\d+)?/g;
	const mentionPathSet = $derived(new Set(mentionPaths));

	function escapeHtml(s: string): string {
		return s.replace(
			/[&<>]/g,
			(c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"),
		);
	}

	// Only tokens that name a real mentionable file become pills; a bare `@foo`
	// or an in-progress token stays plain text. Unmatched stretches fall through
	// into the next plain slice, so nothing is dropped.
	const overlayHtml = $derived.by(() => {
		const value = ctx.value;
		let html = "";
		let last = 0;
		MENTION_RE.lastIndex = 0;
		for (let m = MENTION_RE.exec(value); m; m = MENTION_RE.exec(value)) {
			const path = m[1] ?? "";
			if (!mentionPathSet.has(path)) continue;
			html += `${escapeHtml(value.slice(last, m.index))}<span class="composer-mention">${escapeHtml(m[0])}</span>`;
			last = m.index + m[0].length;
		}
		html += escapeHtml(value.slice(last));
		// A trailing newline leaves no glyph for the browser to give height to;
		// a zero-width space keeps the overlay's last line in sync with the
		// textarea's so the two never drift by a row.
		return value.endsWith("\n") ? `${html}​` : html;
	});

	function syncScroll() {
		if (!overlayEl || !textareaEl) return;
		overlayEl.scrollTop = textareaEl.scrollTop;
		overlayEl.scrollLeft = textareaEl.scrollLeft;
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

<div class="ta-wrap">
	<!-- Visible mirror layer: same box + typography as the textarea, styling the
	     `@path` tokens. The textarea above it carries transparent text + a
	     visible caret, so editing semantics are untouched. -->
	<div
		bind:this={overlayEl}
		aria-hidden="true"
		class={cn("ta-overlay px-4 py-3 text-sm leading-relaxed text-foreground", className)}
	>{@html overlayHtml}</div>
	<textarea
		bind:this={textareaEl}
		value={ctx.value}
		oninput={(e) => {
			ctx.setValue(e.currentTarget.value);
			// Real typing re-arms the menu after an Escape/selection dismiss.
			dismissed = false;
			autoResize();
			syncScroll();
		}}
		onscroll={syncScroll}
		data-slot="prompt-input-textarea"
		class={cn(
			"ta-field block w-full min-h-[2.75rem] resize-none bg-transparent px-4 py-3 text-sm leading-relaxed placeholder:text-muted-foreground focus:outline-none",
			className,
		)}
		{placeholder}
		rows={1}
		onkeydown={handleKeydown}
		{...restProps}
	></textarea>
</div>

<style>
	.ta-wrap {
		position: relative;
	}
	/* Mirror layer sits under the textarea, sharing its exact box so glyphs
	   register. Wrapping must match the textarea's: pre-wrap + break-anywhere. */
	.ta-overlay {
		position: absolute;
		inset: 0;
		z-index: 0;
		/* Identical box model to the textarea is what keeps the available text
		   width — and therefore every wrap point — in lockstep. */
		box-sizing: border-box;
		overflow: hidden;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		pointer-events: none;
		user-select: none;
		color: var(--color-foreground);
	}
	.ta-field {
		position: relative;
		z-index: 1;
		box-sizing: border-box;
		/* Text is invisible (the overlay renders it); only the caret shows. */
		color: transparent;
		caret-color: var(--color-foreground);
	}
	/* Injected via {@html}, so global. No horizontal padding — a box-shadow halo
	   gives the pill breathing room without shifting the glyphs the caret tracks. */
	:global(.ta-overlay .composer-mention) {
		border-radius: 4px;
		background: color-mix(in srgb, var(--color-accent) 16%, transparent);
		box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--color-accent) 16%, transparent);
		color: var(--color-accent);
	}
</style>
