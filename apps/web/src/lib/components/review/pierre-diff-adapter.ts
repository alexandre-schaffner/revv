import {
  DIFFS_TAG_NAME,
  type FileDiffMetadata,
  type FileDiffOptions,
  HEADER_METADATA_SLOT_ID,
  HEADER_PREFIX_SLOT_ID,
  Virtualizer,
} from "@pierre/diffs";
import type { HunkScanRow } from "@revv/shared";
import { hunkTone, rowMatchesHunk, type SmellTone } from "$lib/utils/hunk-scan";

export interface ThreadMeta {
  threadId: string;
  status: string;
  messageCount: number;
  isExpanded: boolean;
  isInputActive: boolean;
  isReplying: boolean;
  isPending: boolean;
}

export const PIERRE_BASE_CSS = `[data-diffs-header='default'] { position: static !important; }`;

/**
 * CSS for the first pass's gutter bars: a 2px rule on the right edge of every
 * line-number cell in a flagged hunk, tinted by the hunk's worst smell.
 * `::after`, because Pierre already paints the change bar in `::before`.
 *
 * Gutter cells carry `data-line-index="<unified>,<split>"` in both diff styles,
 * so matching the unified prefix covers unified and split alike. Pierre's DOM
 * has no per-hunk hook that survives virtualization (the window can start
 * mid-hunk), so it is one prefix per line, folded into a single `:is()` per
 * tone. A row whose range disagrees with Pierre's hunk at that index came from
 * another diff and is skipped rather than marking the wrong lines.
 */
export function firstPassGutterCss(
  fileDiff: FileDiffMetadata | null,
  rows: readonly HunkScanRow[],
): string {
  if (!fileDiff) return "";
  const lines: Record<SmellTone, string[]> = { warning: [], danger: [] };
  for (const row of rows) {
    const tone = hunkTone(row);
    const hunk = fileDiff.hunks[row.hunkIndex];
    if (tone === null || !hunk) continue;
    if (!rowMatchesHunk(row, { newStart: hunk.additionStart, newLines: hunk.additionCount })) {
      continue;
    }
    for (let i = hunk.unifiedLineStart; i < hunk.unifiedLineStart + hunk.unifiedLineCount; i++) {
      lines[tone].push(`[data-line-index^="${i},"]`);
    }
  }
  return (["warning", "danger"] as const)
    .filter((tone) => lines[tone].length > 0)
    .map(
      (tone) =>
        `[data-column-number]:is(${lines[tone].join(",")})::after { content: ""; position: absolute; top: 0; bottom: 0; right: 0; width: 2px; pointer-events: none; background: color-mix(in srgb, var(--color-${tone}) 70%, transparent); }`,
    )
    .join(" ");
}

/**
 * A stylesheet of our own on Pierre's shadow root. Pierre keeps one `unsafeCSS`
 * string and re-parses all of it whenever any part changes, so CSS that
 * changes on its own schedule (the first pass, per scan event) lives here
 * rather than riding along with the per-keypress cursor highlight. It sits in
 * Pierre's `unsafe` layer, so it cascades as if it were part of `unsafeCSS`.
 */
export class ShadowSheet {
  private sheet: CSSStyleSheet | null = null;
  private applied = "";

  apply(root: ShadowRoot | null, css: string): void {
    if (root === null) return;
    if (this.sheet === null) this.sheet = new CSSStyleSheet();
    if (css !== this.applied) {
      this.sheet.replaceSync(`@layer unsafe { ${css} }`);
      this.applied = css;
    }
    if (!root.adoptedStyleSheets.includes(this.sheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, this.sheet];
    }
  }
}

export function createDiffsHost(): HTMLElement {
  return document.createElement(DIFFS_TAG_NAME);
}

export function findShadowHost(container: HTMLElement): HTMLElement | null {
  for (const child of container.children) {
    if (child instanceof HTMLElement && child.shadowRoot) return child;
  }
  for (const child of container.children) {
    if (child instanceof HTMLElement) {
      for (const grandchild of child.children) {
        if (grandchild instanceof HTMLElement && grandchild.shadowRoot) {
          return grandchild;
        }
      }
    }
  }
  return null;
}

export function getPierreShadowRoot(container: HTMLElement | null): ShadowRoot | null {
  if (!container) return null;
  return findShadowHost(container)?.shadowRoot ?? null;
}

export function populateDiffHeaderSlots(
  hostEl: HTMLElement,
  fileDiff: FileDiffMetadata,
  opts: FileDiffOptions<ThreadMeta, undefined>,
): void {
  function appendSlot(slotName: string, content: string | number | Element | null | undefined) {
    if (content == null) return;
    const slotEl = document.createElement("div");
    slotEl.slot = slotName;
    if (content instanceof Element) slotEl.appendChild(content);
    else slotEl.innerText = String(content);
    hostEl.appendChild(slotEl);
  }
  appendSlot(HEADER_PREFIX_SLOT_ID, opts.renderHeaderPrefix?.(fileDiff));
  appendSlot(HEADER_METADATA_SLOT_ID, opts.renderHeaderMetadata?.(fileDiff));
}

export function createHeaderBadge(label: string, color: string): HTMLElement {
  const badge = document.createElement("span");
  badge.textContent = label;
  badge.style.cssText = `font-size:9px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;background:color-mix(in srgb, ${color} 13%, transparent);color:${color};border-radius:3px;padding:1px 5px;`;
  return badge;
}

export function createPierreVirtualizer(
  scrollRoot: HTMLElement | null,
  contentContainer: HTMLElement,
): Virtualizer | null {
  if (scrollRoot === null) return null;
  const virtualizer = new Virtualizer();
  virtualizer.setup(scrollRoot, contentContainer);
  return virtualizer;
}
