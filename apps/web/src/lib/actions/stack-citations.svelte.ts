// ── `#N (layer k)` citations in a stacked PR's walkthrough ─────────────────
//
// The walkthrough agent cites the other layers of a stack as `#122 (layer 3)`.
// This action walks the rendered markdown and turns each citation of a PR in
// the stack on screen into a compact chip (the layer's state glyph and its
// number) that opens that layer. A `#N` that isn't a member, or isn't written
// as a layer citation, stays text: an issue reference reads the same way and
// must not become a stack jump.
//
// Same shape as `mentionReferences`: a MutationObserver re-decorates as the
// stream lands content, microtask-scheduled so it runs after Svelte patches
// the DOM, paused while it mutates so its own nodes don't re-trigger it.

import type { StackEntryStatus, StackLayer } from "@revv/shared";
import type { Action } from "svelte/action";
import { phosphorMarkup } from "$lib/utils/phosphor-markup";

export interface StackCitations {
  readonly layers: readonly StackLayer[];
  /** The layer on screen. Cited, it reads as a chip but goes nowhere. */
  readonly currentNumber: number;
  readonly open: (layer: StackLayer) => void;
}

const CITE_CLASS = "stack-cite";
const NUMBER_ATTR = "data-stack-number";
/** The text a chip replaced, so a chip can turn back into it. */
const SOURCE_ATTR = "data-stack-source";

const CITATION_RE = /#(\d+)\s*\(layer\s+\d+(?:\s+of\s+\d+)?\)/gi;

const GLYPH: Record<StackEntryStatus, string> = {
  merged: phosphorMarkup("GitMerge", { size: 12 }),
  closed: phosphorMarkup("XCircle", { size: 12 }),
  draft: phosphorMarkup("FileDashed", { size: 12 }),
  ready: phosphorMarkup("CheckCircle", { size: 12, weight: "fill" }),
  not_ready: phosphorMarkup("MinusCircle", { size: 12, weight: "fill" }),
};

/**
 * Bring a chip up to date with the stack as it stands: its glyph follows the
 * layer's state, and its title is the hover that names the layer. Called on
 * every pass, so a chip minted before a layer merged picks the merge up.
 */
function syncChip(chip: HTMLElement, layer: StackLayer, currentNumber: number): void {
  const here = layer.number === currentNumber;
  const status = chip.dataset.status;
  if (status !== layer.status) {
    chip.dataset.status = layer.status;
    const glyph = chip.querySelector(".stack-cite-glyph");
    if (glyph) glyph.innerHTML = GLYPH[layer.status];
  }
  const label = `#${layer.number}, layer ${layer.position}: ${layer.title}`;
  chip.title = here ? `${label} (this layer)` : label;
  chip.setAttribute("aria-label", here ? `${label}, the layer on screen` : `Open ${label}`);
  chip.toggleAttribute("disabled", here);
}

function makeChip(source: string, layer: StackLayer, currentNumber: number): HTMLElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = CITE_CLASS;
  chip.setAttribute(NUMBER_ATTR, String(layer.number));
  chip.setAttribute(SOURCE_ATTR, source);

  const glyph = document.createElement("span");
  glyph.className = "stack-cite-glyph";
  glyph.setAttribute("aria-hidden", "true");
  const num = document.createElement("span");
  num.className = "stack-cite-num";
  num.textContent = `#${layer.number}`;
  const where = document.createElement("span");
  where.className = "stack-cite-layer";
  where.textContent = `layer ${layer.position}`;
  chip.append(glyph, num, where);

  syncChip(chip, layer, currentNumber);
  return chip;
}

function decorateTextNode(
  text: Text,
  byNumber: ReadonlyMap<number, StackLayer>,
  currentNumber: number,
): void {
  const value = text.nodeValue ?? "";
  const frag = document.createDocumentFragment();
  let last = 0;
  let changed = false;
  for (const match of value.matchAll(CITATION_RE)) {
    const layer = byNumber.get(Number(match[1]));
    if (!layer) continue;
    if (match.index > last) frag.append(value.slice(last, match.index));
    frag.append(makeChip(match[0], layer, currentNumber));
    last = match.index + match[0].length;
    changed = true;
  }
  if (!changed) return;
  if (last < value.length) frag.append(value.slice(last));
  text.replaceWith(frag);
}

/** Text a citation can't sit in: links, code, and chips already minted. */
const SKIP = `a, code, pre, button, .${CITE_CLASS}`;

function decorate(node: HTMLElement, citations: StackCitations | null): void {
  if (!citations) {
    for (const chip of node.querySelectorAll<HTMLElement>(`.${CITE_CLASS}`)) {
      chip.replaceWith(document.createTextNode(chip.getAttribute(SOURCE_ATTR) ?? ""));
    }
    return;
  }
  const byNumber = new Map(citations.layers.map((l) => [l.number, l]));
  for (const chip of node.querySelectorAll<HTMLElement>(`.${CITE_CLASS}`)) {
    const layer = byNumber.get(Number(chip.getAttribute(NUMBER_ATTR)));
    if (layer) syncChip(chip, layer, citations.currentNumber);
    else chip.replaceWith(document.createTextNode(chip.getAttribute(SOURCE_ATTR) ?? ""));
  }
  // Only rendered markdown carries citations; the diff and the chrome around
  // it never do, and walking them would cost a pass over every line of code.
  const roots = node.matches(".prose")
    ? [node]
    : Array.from(node.querySelectorAll<HTMLElement>(".prose"));
  const texts: Text[] = [];
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const value = n.nodeValue ?? "";
      if (!value.includes("#") || !/layer/i.test(value)) continue;
      if (n.parentElement?.closest(SKIP)) continue;
      texts.push(n as Text);
    }
  }
  for (const t of texts) decorateTextNode(t, byNumber, citations.currentNumber);
}

/**
 * The bound value is the stack the walkthrough belongs to, or null when the
 * PR isn't stacked (which also turns any chips back into text).
 */
export const stackCitations: Action<HTMLElement, StackCitations | null | undefined> = (
  node,
  value,
) => {
  let destroyed = false;
  let scheduled = false;
  let citations: StackCitations | null = value ?? null;

  const schedule = (): void => {
    if (destroyed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (destroyed) return;
      observer.disconnect();
      decorate(node, citations);
      if (!destroyed) observer.observe(node, { childList: true, subtree: true });
    });
  };

  const onClick = (e: MouseEvent): void => {
    const chip = (e.target as HTMLElement | null)?.closest<HTMLElement>(`.${CITE_CLASS}`);
    if (!chip || !citations || !node.contains(chip)) return;
    e.preventDefault();
    const number = Number(chip.getAttribute(NUMBER_ATTR));
    if (number === citations.currentNumber) return;
    const layer = citations.layers.find((l) => l.number === number);
    if (layer) citations.open(layer);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(node, { childList: true, subtree: true });
  node.addEventListener("click", onClick);
  schedule();

  return {
    update(next) {
      citations = next ?? null;
      schedule();
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
      node.removeEventListener("click", onClick);
    },
  };
};
