import {
  DIFFS_TAG_NAME,
  type FileDiffMetadata,
  type FileDiffOptions,
  HEADER_METADATA_SLOT_ID,
  HEADER_PREFIX_SLOT_ID,
  Virtualizer,
} from "@pierre/diffs";

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
  opts: FileDiffOptions<ThreadMeta>,
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
