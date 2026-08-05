// ── Composer contenteditable model (pure DOM) ────────────────────────────────
//
// The chat composer is a `contenteditable` surface, NOT a `<textarea>`: a
// `@path` mention is a real, non-editable "pill" node while everything else is
// plain text. The backend contract is still a flat string, so the DOM is
// serialized back — each pill to its `@path[:line]` token — on every edit.
//
// Everything here is a pure function over `Node`/`Range`/`Selection` and the
// known-mention set; nothing reads Svelte reactivity. It lives outside the
// component so the gnarly parts (WebKit's two-backspace pill behavior, the
// whitespace-node walking, the serialize/render round-trip) are unit-testable
// under jsdom without mounting a component. The component keeps only the
// reactive glue (`trigger`, `menuOpen`, effects, event wiring).

import { MENTION_PATH_PATTERN } from "@revv/shared";

import { appendPillContents } from "$lib/utils/file-glyph";

export const PILL_CLASS = "composer-pill";

// Block-level elements a `contenteditable` may acquire (chiefly from a paste):
// each begins its content on a fresh line, so the serializer treats a block
// boundary as a newline. Without this, `<div>a</div><div>b</div>` collapses to
// `ab` and a multi-line paste loses its interior newlines.
const BLOCK_TAGS = new Set(["DIV", "P", "LI", "SECTION", "ARTICLE", "BLOCKQUOTE"]);

/**
 * Build an atomic mention pill. `token` is the full `@path[:line]` string the
 * pill re-emits on serialize (so a line suffix survives a re-render); `path` is
 * the resolvable path used for the glyph and basename label.
 */
export function makePill(token: string, path: string): HTMLElement {
  const span = document.createElement("span");
  span.className = PILL_CLASS;
  span.contentEditable = "false";
  span.dataset.token = token;
  span.title = path;
  appendPillContents(span, path, "composer-pill-icon");
  return span;
}

function isPillElement(el: HTMLElement): boolean {
  return el.classList.contains(PILL_CLASS);
}

function isFillerBlock(el: HTMLElement): boolean {
  return Array.from(el.childNodes).every((child) => {
    if (child.nodeType === Node.TEXT_NODE) return (child.nodeValue ?? "").length === 0;
    return child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).tagName === "BR";
  });
}

function serializeInto(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.nodeValue ?? "");
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  if (isPillElement(el)) {
    out.push(el.dataset.token ?? "");
    return;
  }
  if (el.tagName === "BR") {
    out.push("\n");
    return;
  }
  if (BLOCK_TAGS.has(el.tagName)) {
    serializeBlock(el, out, out.length > 0);
    return;
  }
  serializeChildren(el.childNodes, out);
}

function serializeBlock(el: HTMLElement, out: string[], needsBoundary: boolean): void {
  if (needsBoundary) out.push("\n");
  if (isFillerBlock(el)) return;
  serializeChildren(el.childNodes, out);
}

function serializeChildren(children: NodeListOf<ChildNode>, out: string[]): void {
  let i = 0;
  for (const child of children) {
    if (child.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((child as HTMLElement).tagName)) {
      serializeBlock(child as HTMLElement, out, i > 0 || out.length > 0);
    } else {
      serializeInto(child, out);
    }
    i += 1;
  }
}

/** Serialize a node tree back to the flat `@path`-bearing message string. */
export function serialize(root: Node | null | undefined): string {
  if (!root) return "";
  const out: string[] = [];
  serializeChildren(root.childNodes, out);
  return out.join("");
}

function appendInlineText(parent: Node, text: string): void {
  if (text) parent.appendChild(document.createTextNode(text));
}

function appendPillifiedInlineText(
  parent: Node,
  value: string,
  mentionPathSet: ReadonlySet<string>,
): void {
  const re = new RegExp(MENTION_PATH_PATTERN, "g");
  let last = 0;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    const path = m[1] ?? "";
    if (!mentionPathSet.has(path)) continue;
    if (m.index > last) appendInlineText(parent, value.slice(last, m.index));
    // `m[0]` is the whole `@path[:line]` token, so the pill preserves the line
    // suffix through a re-render instead of silently dropping it.
    parent.appendChild(makePill(m[0], path));
    last = m.index + m[0].length;
  }
  if (last < value.length) appendInlineText(parent, value.slice(last));
}

/** Rebuild the editor DOM from a flat string, pillifying known mentions. */
export function render(
  editorEl: HTMLElement,
  value: string,
  mentionPathSet: ReadonlySet<string>,
): void {
  const frag = document.createDocumentFragment();

  if (value.length === 0) {
    editorEl.replaceChildren();
    return;
  }

  value.split("\n").forEach((line) => {
    const div = document.createElement("div");
    appendPillifiedInlineText(div, line, mentionPathSet);
    if (div.childNodes.length === 0) div.appendChild(document.createElement("br"));
    frag.appendChild(div);
  });
  editorEl.replaceChildren(frag);
}

export function insertLineBreak(editorEl: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!editorEl.contains(range.commonAncestorContainer)) return false;

  return document.execCommand("insertParagraph");
}

// ── Caret-relative helpers ────────────────────────────────────────────────────
// `savedRange` is the last collapsed caret inside the editor, threaded in by the
// component so a mouse selection of an autocomplete row (which would otherwise
// blur the editor and drop the live selection) can still target the right spot.

export function editorCaret(editorEl: HTMLElement, savedRange: Range | null): Range | null {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    if (range.collapsed && editorEl.contains(range.startContainer)) return range;
  }
  return savedRange;
}

export function caretTextBefore(editorEl: HTMLElement, savedRange: Range | null): string {
  const range = editorCaret(editorEl, savedRange);
  if (!range) return "";
  const pre = range.cloneRange();
  pre.selectNodeContents(editorEl);
  pre.setEnd(range.startContainer, range.startOffset);
  return serialize(pre.cloneContents());
}

// The active token is freshly-typed plain text ending at the caret, so it lives
// in one text node; delete `marker + query` chars and return the emptied range
// for the caller to drop in a pill (mentions) or text (slash commands).
export function replaceTokenRange(
  editorEl: HTMLElement,
  savedRange: Range | null,
  markerAndQueryLen: number,
): Range | null {
  const caret = editorCaret(editorEl, savedRange);
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

export function placeCaretAfter(node: Node): void {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.setStartAfter(node);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

// ── Pill deletion ─────────────────────────────────────────────────────────────

export function isPill(node: Node | null): node is HTMLElement {
  return node?.nodeType === Node.ELEMENT_NODE && isPillElement(node as HTMLElement);
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

// The node a Delete (forward) would act on, given a collapsed caret. Returns
// null when there's ordinary text to delete forward (let the browser handle it).
export function forwardNode(range: Range): Node | null {
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

/** The plan a single Backspace should apply near a pill. */
export interface PillDeleteTarget {
  pill: HTMLElement;
  /** Whitespace/empty text nodes to delete whole. */
  removeNodes: Node[];
  /** Caret's own text node whose leading whitespace prefix should be trimmed. */
  trimNode: Text | null;
  /** Length of that whitespace prefix. */
  trimLen: number;
  /** Where the caret should collapse afterward (kept node). */
  caretNode: Node | null;
}

// What a single Backspace should remove: the pill just before the caret, plus
// any auto-inserted whitespace sitting between it and the caret (so the
// `[pill][" "]` a mention insertion leaves behind — where the caret lands at
// element level right after the space — dies in one press instead of two).
// Returns null when there's ordinary text to delete first: then the browser
// handles it.
export function backwardPillTarget(range: Range): PillDeleteTarget | null {
  const { startContainer: c, startOffset: o } = range;

  // The node just left of the caret, and the text prefix to strip if the caret
  // sits inside a (whitespace-only) text node.
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

// Collapse the caret before `anchor` if it's still attached, else to the end of
// the editor. Shared by both delete directions so the fallback lives once.
function collapseCaretBefore(sel: Selection, anchor: Node | null, editorEl: HTMLElement): void {
  const r = document.createRange();
  if (anchor?.parentNode) r.setStartBefore(anchor);
  else {
    r.selectNodeContents(editorEl);
    r.collapse(false);
  }
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Remove a pill via forward Delete; caret collapses where it stood. */
export function deletePillForward(editorEl: HTMLElement, sel: Selection, pill: HTMLElement): void {
  const anchor = pill.nextSibling;
  pill.remove();
  collapseCaretBefore(sel, anchor, editorEl);
}

/** Apply a backward (Backspace) pill-deletion plan; caret collapses where it stood. */
export function deletePillBackward(
  editorEl: HTMLElement,
  sel: Selection,
  target: PillDeleteTarget,
): void {
  if (target.trimNode && target.trimLen > 0) {
    target.trimNode.nodeValue = (target.trimNode.nodeValue ?? "").slice(target.trimLen);
  }
  for (const n of target.removeNodes) n.parentNode?.removeChild(n);
  target.pill.remove();
  collapseCaretBefore(sel, target.caretNode, editorEl);
}
