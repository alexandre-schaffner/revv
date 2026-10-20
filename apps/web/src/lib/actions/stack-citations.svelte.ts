// ── `#N (layer k)` citations in a stacked PR's walkthrough ─────────────────
//
// The walkthrough agent cites the other layers of a stack as `#122 (layer 3)`.
// This action walks the rendered markdown and turns each citation of a PR in
// the stack on screen into the margin notes' `LayerChip` (the layer's state
// glyph and its number), which opens that layer. A `#N` that isn't a member,
// or isn't written as a layer citation, stays text: an issue reference reads
// the same way and must not become a stack jump.
//
// Same shape as `mentionReferences`: a MutationObserver re-decorates as the
// stream lands content, microtask-scheduled so it runs after Svelte patches
// the DOM, paused while it mutates so its own nodes don't re-trigger it.

import type { StackLayer } from "@revv/shared";
import { mount, unmount } from "svelte";
import type { Action } from "svelte/action";
import LayerChip from "$lib/components/stack/margin/LayerChip.svelte";
import type { StackPlace } from "$lib/components/stack/margin/stack-margin";

const CITE_CLASS = "stack-cite";
const NUMBER_ATTR = "data-stack-number";
/** The text a chip replaced, so a chip can turn back into it. */
const SOURCE_ATTR = "data-stack-source";

const CITATION_RE = /#(\d+)\s*\(layer\s+\d+(?:\s+of\s+\d+)?\)/gi;

/** A mounted chip, and the way to hand it the stack as it stands. */
interface Chip {
  readonly instance: ReturnType<typeof mount>;
  readonly update: (layer: StackLayer, place: StackPlace) => void;
}

function mountChip(host: HTMLElement, layer: StackLayer, place: StackPlace): Chip {
  let current = $state.raw({ layer, place });
  const instance = mount(LayerChip, {
    target: host,
    props: {
      get layer() {
        return current.layer;
      },
      get place() {
        return current.place;
      },
    },
  });
  return {
    instance,
    update: (nextLayer, nextPlace) => {
      current = { layer: nextLayer, place: nextPlace };
    },
  };
}

/** Text a citation can't sit in: links, code, and chips already minted. */
const SKIP = `a, code, pre, button, .${CITE_CLASS}`;

/**
 * The bound value is the PR's place in its stack, or null when it isn't
 * stacked (which also turns any chips back into text).
 */
export const stackCitations: Action<HTMLElement, StackPlace | null | undefined> = (node, value) => {
  let destroyed = false;
  let scheduled = false;
  let place: StackPlace | null = value ?? null;
  const chips = new Map<HTMLElement, Chip>();

  const unmountChip = (host: HTMLElement): void => {
    const chip = chips.get(host);
    if (chip) void unmount(chip.instance);
    chips.delete(host);
  };

  const revert = (host: HTMLElement): void => {
    unmountChip(host);
    host.replaceWith(document.createTextNode(host.getAttribute(SOURCE_ATTR) ?? ""));
  };

  const decorateTextNode = (
    text: Text,
    byNumber: ReadonlyMap<number, StackLayer>,
    at: StackPlace,
  ): void => {
    const value = text.nodeValue ?? "";
    const frag = document.createDocumentFragment();
    const minted: [HTMLElement, StackLayer][] = [];
    let last = 0;
    for (const match of value.matchAll(CITATION_RE)) {
      const layer = byNumber.get(Number(match[1]));
      if (!layer) continue;
      if (match.index > last) frag.append(value.slice(last, match.index));
      const host = document.createElement("span");
      host.className = CITE_CLASS;
      host.setAttribute(NUMBER_ATTR, String(layer.number));
      host.setAttribute(SOURCE_ATTR, match[0]);
      frag.append(host);
      minted.push([host, layer]);
      last = match.index + match[0].length;
    }
    if (minted.length === 0) return;
    if (last < value.length) frag.append(value.slice(last));
    text.replaceWith(frag);
    for (const [host, layer] of minted) chips.set(host, mountChip(host, layer, at));
  };

  const decorate = (): void => {
    // `{@html}` re-renders drop hosts without telling us; their chips go too.
    for (const host of [...chips.keys()]) {
      if (!node.contains(host)) unmountChip(host);
    }
    if (!place) {
      for (const host of [...chips.keys()]) revert(host);
      return;
    }
    const at = place;
    const byNumber = new Map(at.stack.layers.map((l) => [l.number, l]));
    for (const [host, chip] of [...chips]) {
      const layer = byNumber.get(Number(host.getAttribute(NUMBER_ATTR)));
      if (layer) chip.update(layer, at);
      else revert(host);
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
    for (const t of texts) decorateTextNode(t, byNumber, at);
  };

  const schedule = (): void => {
    if (destroyed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (destroyed) return;
      observer.disconnect();
      decorate();
      if (!destroyed) observer.observe(node, { childList: true, subtree: true });
    });
  };

  const observer = new MutationObserver(schedule);
  observer.observe(node, { childList: true, subtree: true });
  schedule();

  return {
    update(next) {
      place = next ?? null;
      schedule();
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
      for (const host of [...chips.keys()]) unmountChip(host);
    },
  };
};
