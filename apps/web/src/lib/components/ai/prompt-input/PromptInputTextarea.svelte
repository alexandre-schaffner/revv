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
	import { basename } from "$lib/utils/activity-groups";
	import { fileIcon } from "$lib/utils/file-icon";
	import { createFileGlyph } from "$lib/utils/file-glyph";
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

	const isEmpty = $derived(ctx.value.trim().length === 0);

	$effect(() => {
		void trigger?.kind;
		void trigger?.query;
		activeIndex = 0;
	});

	// ── Mentions in the editor are atomic pills ──────────────────────────────
	// The editor is a contenteditable surface, NOT a textarea: a `@path` mention
	// is a real, non-editable pill node, while everything else is plain text.
	// `ctx.value` stays a flat string (the backend's contract) by serializing the
	// DOM — each pill back to its `@path` token — on every edit.
	const MENTION_RE = /@((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+)(?::\d+)?/g;
	const PILL_CLASS = "composer-pill";

	function makePill(path: string): HTMLElement {
		const span = document.createElement("span");
		span.className = PILL_CLASS;
		span.contentEditable = "false";
		span.dataset.token = `@${path}`;
		span.title = path;
		span.appendChild(createFileGlyph(path, "composer-pill-icon"));
		const label = document.createElement("span");
		label.textContent = basename(path);
		span.appendChild(label);
		return span;
	}

	/** Serialize a node tree back to the flat `@path`-bearing message string. */
	function serializeNode(node: Node): string {
		if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
		if (node.nodeType !== Node.ELEMENT_NODE) return "";
		const el = node as HTMLElement;
		if (el.classList.contains(PILL_CLASS)) return el.dataset.token ?? "";
		if (el.tagName === "BR") return "\n";
		let s = "";
		for (const child of el.childNodes) s += serializeNode(child);
		return s;
	}

	function serialize(root: Node | undefined): string {
		if (!root) return "";
		let s = "";
		for (const child of root.childNodes) s += serializeNode(child);
		return s;
	}

	/** Rebuild the editor DOM from a flat string, pillifying known mentions. */
	function render(value: string) {
		if (!editorEl) return;
		const frag = document.createDocumentFragment();
		let last = 0;
		MENTION_RE.lastIndex = 0;
		for (let m = MENTION_RE.exec(value); m; m = MENTION_RE.exec(value)) {
			const path = m[1] ?? "";
			if (!mentionPathSet.has(path)) continue;
			if (m.index > last) appendText(frag, value.slice(last, m.index));
			frag.append(makePill(path));
			last = m.index + m[0].length;
		}
		if (last < value.length) appendText(frag, value.slice(last));
		editorEl.replaceChildren(frag);
	}

	// Newlines render as <br> (matching what the browser inserts on Shift+Enter)
	// so the two never mix; plain runs become text nodes.
	function appendText(frag: DocumentFragment, text: string) {
		const parts = text.split("\n");
		parts.forEach((part, i) => {
			if (i > 0) frag.append(document.createElement("br"));
			if (part) frag.append(document.createTextNode(part));
		});
	}

	// Keep the editor DOM in step with programmatic value changes (the submit
	// clear, mainly). Skip when the DOM already serializes to `ctx.value` — i.e.
	// during normal typing — so we never stomp the caret mid-edit.
	$effect(() => {
		const v = ctx.value;
		if (!editorEl || v === serialize(editorEl)) return;
		render(v);
	});

	function pushValue() {
		ctx.setValue(serialize(editorEl));
	}

	// ── Caret-relative trigger detection ─────────────────────────────────────
	// The last collapsed caret inside the editor. Saved on every interaction so
	// selecting an autocomplete row with the mouse — which would otherwise blur
	// the editor and drop the live selection — can still target the right spot.
	let savedRange: Range | null = null;

	function editorCaret(): Range | null {
		const sel = window.getSelection();
		if (sel && sel.rangeCount > 0) {
			const range = sel.getRangeAt(0);
			if (range.collapsed && editorEl?.contains(range.startContainer)) return range;
		}
		return savedRange;
	}

	function caretTextBefore(): string {
		const range = editorCaret();
		if (!range || !editorEl) return "";
		const pre = range.cloneRange();
		pre.selectNodeContents(editorEl);
		pre.setEnd(range.startContainer, range.startOffset);
		return serialize(pre.cloneContents());
	}

	function refreshTrigger() {
		const sel = window.getSelection();
		if (sel && sel.rangeCount > 0) {
			const range = sel.getRangeAt(0);
			if (range.collapsed && editorEl?.contains(range.startContainer)) {
				savedRange = range.cloneRange();
			}
		}
		trigger = detectMentionTrigger(caretTextBefore());
	}

	// ── Token replacement (autocomplete selection) ───────────────────────────
	// The active token is freshly-typed plain text ending at the caret, so it
	// lives in one text node; delete `marker + query` chars and drop in the
	// replacement (a pill for mentions, plain text for slash commands).
	function replaceTokenRange(markerAndQueryLen: number): Range | null {
		const caret = editorCaret();
		if (!caret) return null;
		const node = caret.startContainer;
		if (node.nodeType !== Node.TEXT_NODE) return null;
		const start = caret.startOffset - markerAndQueryLen;
		if (start < 0) return null;
		const r = document.createRange();
		r.setStart(node, start);
		r.setEnd(node, caret.startOffset);
		r.deleteContents();
		return r;
	}

	function placeCaretAfter(node: Node) {
		const sel = window.getSelection();
		if (!sel) return;
		const r = document.createRange();
		r.setStartAfter(node);
		r.collapse(true);
		sel.removeAllRanges();
		sel.addRange(r);
	}

	function applyMention(path: string) {
		if (trigger?.kind !== "mention") return;
		const r = replaceTokenRange(trigger.query.length + 1);
		if (!r) return;
		const space = document.createTextNode(" ");
		const pill = makePill(path);
		r.insertNode(space);
		r.insertNode(pill);
		placeCaretAfter(space);
		closeMenuAfterInsert();
	}

	function applySlash(name: string) {
		if (trigger?.kind !== "slash") return;
		const r = replaceTokenRange(trigger.query.length + 1);
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

	function isPill(node: Node | null): node is HTMLElement {
		return (
			node?.nodeType === Node.ELEMENT_NODE &&
			(node as HTMLElement).classList.contains(PILL_CLASS)
		);
	}

	// Walk past empty text nodes the browser may leave between siblings so an
	// adjacent pill is still recognized.
	function skipEmptyText(node: Node | null, dir: "prev" | "next"): Node | null {
		let n = node;
		while (n && n.nodeType === Node.TEXT_NODE && n.nodeValue === "") {
			n = dir === "prev" ? n.previousSibling : n.nextSibling;
		}
		return n;
	}

	// The node a Delete (next) would act on, given a collapsed caret. Returns
	// null when there's ordinary text to delete forward (let the browser handle
	// it).
	function forwardNode(range: Range): Node | null {
		const { startContainer: c, startOffset: o } = range;
		if (c.nodeType === Node.TEXT_NODE) {
			if (o !== (c.nodeValue?.length ?? 0)) return null;
			return skipEmptyText(c.nextSibling, "next");
		}
		return skipEmptyText(c.childNodes[o] ?? null, "next");
	}

	function isWhitespaceText(node: Node | null): boolean {
		return node?.nodeType === Node.TEXT_NODE && (node.nodeValue ?? "").trim().length === 0;
	}

	// What a single Backspace should remove: the pill just before the caret, plus
	// any auto-inserted whitespace sitting between it and the caret (so the
	// `[pill][" "]` a mention insertion leaves behind — where the caret lands at
	// element level right after the space — dies in one press instead of two).
	// Returns null when there's ordinary text to delete first: then the browser
	// handles it. `removeNodes` are whitespace/empty text nodes to delete whole;
	// `trimNode`'s first `trimLen` chars are the whitespace prefix to strip from
	// the caret's own text node; `caretNode` is where the caret should collapse.
	function backwardPillTarget(range: Range): {
		pill: HTMLElement;
		removeNodes: Node[];
		trimNode: Text | null;
		trimLen: number;
		caretNode: Node | null;
	} | null {
		const { startContainer: c, startOffset: o } = range;

		// The node just left of the caret, and the text prefix to strip if the
		// caret sits inside a (whitespace-only) text node.
		let scan: Node | null;
		let trimNode: Text | null = null;
		let trimLen = 0;
		let caretNode: Node | null;
		if (c.nodeType === Node.TEXT_NODE) {
			const before = (c.nodeValue ?? "").slice(0, o);
			if (before.trim().length > 0) return null; // real text → normal delete
			trimNode = c as Text;
			trimLen = before.length;
			caretNode = c; // keep this node; caret collapses to its start
			scan = c.previousSibling;
		} else {
			caretNode = c.childNodes[o] ?? null; // node the caret sits before (kept)
			scan = c.childNodes[o - 1] ?? null;
		}

		// Walk left across whitespace/empty text nodes to reach the pill.
		const removeNodes: Node[] = [];
		while (scan && scan.nodeType === Node.TEXT_NODE) {
			if (!isWhitespaceText(scan)) return null; // real text → normal delete
			removeNodes.push(scan);
			scan = scan.previousSibling;
		}
		if (!isPill(scan)) return null;
		return { pill: scan, removeNodes, trimNode, trimLen, caretNode };
	}

	// Remove a pill and collapse the caret to where it stood.
	function removePill(sel: Selection, pill: HTMLElement) {
		const anchor = pill.nextSibling;
		const parent = pill.parentNode;
		pill.remove();
		const r = document.createRange();
		if (anchor && anchor.parentNode === parent) r.setStartBefore(anchor);
		else {
			r.selectNodeContents(parent ?? (editorEl as Node));
			r.collapse(false);
		}
		r.collapse(true);
		sel.removeAllRanges();
		sel.addRange(r);
		pushValue();
		refreshTrigger();
	}

	// Atomic pill deletion. WebKit otherwise needs two Backspaces on a
	// `contenteditable=false` node (the first only steps the caret over it), so
	// when a pill sits next to the caret we remove it ourselves in one press.
	function deleteAdjacentPill(e: KeyboardEvent): boolean {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return false;
		const range = sel.getRangeAt(0);
		if (!range.collapsed) return false;

		if (e.key === "Delete") {
			const pill = forwardNode(range);
			if (!isPill(pill)) return false;
			e.preventDefault();
			removePill(sel, pill);
			return true;
		}

		const target = backwardPillTarget(range);
		if (!target) return false;
		e.preventDefault();
		if (target.trimNode && target.trimLen > 0) {
			target.trimNode.nodeValue = (target.trimNode.nodeValue ?? "").slice(target.trimLen);
		}
		for (const n of target.removeNodes) n.parentNode?.removeChild(n);
		target.pill.remove();
		const r = document.createRange();
		if (target.caretNode && target.caretNode.parentNode) r.setStartBefore(target.caretNode);
		else {
			r.selectNodeContents(editorEl as Node);
			r.collapse(false);
		}
		r.collapse(true);
		sel.removeAllRanges();
		sel.addRange(r);
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
			// serializer sees a single, predictable break shape.
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
		if (editorEl && ctx.value.trim().length > 0) render(ctx.value);
	}

	// Strip formatting from pasted content (and never inject HTML); file pastes
	// carry no text/plain and fall through to the form's attachment handler.
	function handlePaste(e: ClipboardEvent) {
		const text = e.clipboardData?.getData("text/plain") ?? "";
		if (!text) return;
		e.preventDefault();
		document.execCommand("insertText", false, text);
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
