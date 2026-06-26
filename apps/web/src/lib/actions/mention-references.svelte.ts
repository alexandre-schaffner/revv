// ── @-mention file pills in user messages ───────────────────────────────────
//
// User chat messages embed file mentions as plain text (`@apps/web/src/foo.ts`).
// This action walks the rendered markdown and replaces each `@path` token with a
// file pill — the per-extension glyph + basename — matching the tool-call detail
// pill and the assistant-message file references. When the path resolves to a
// changed file the pill is clickable (opens it in the diff tab); otherwise it's
// a static label.
//
// Mirrors the `fileReferences` action's MutationObserver pattern (re-decorate on
// streaming content changes, microtask-scheduled), pausing observation while we
// mutate so our injected nodes don't re-trigger it.

import type { Action } from "svelte/action";

import { openFileInDiff } from "$lib/stores/review.svelte";
import type { ReviewFile } from "$lib/types/review";
import { basename } from "$lib/utils/activity-groups";
import { createFileGlyph } from "$lib/utils/file-glyph";

const PILL_CLASS = "mention-ref";
const PATH_ATTR = "data-mention-path";
const LINE_ATTR = "data-mention-line";

// `@` followed by a path with an extension, optional `:line`. Conservative on
// purpose so prose `@handle` mentions don't get captured.
const MENTION_RE = /@((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+)(?::(\d+))?/g;

/** A mention resolves to a changed file by exact path or unique basename. */
function resolvePath(candidate: string, files: ReadonlyArray<ReviewFile>): string | null {
  for (const f of files) {
    if (f.path === candidate || f.oldPath === candidate) return f.path;
  }
  const base = basename(candidate);
  const owners = files.filter((f) => basename(f.path) === base);
  if (owners.length === 1 && owners[0]) {
    const only = owners[0].path;
    if (candidate === base || only.endsWith(`/${candidate}`)) return only;
  }
  return null;
}

function makePill(
  fullPath: string,
  line: number | null,
  files: ReadonlyArray<ReviewFile>,
): HTMLElement {
  const resolved = resolvePath(fullPath, files);
  const span = document.createElement("span");
  span.className = PILL_CLASS;
  span.title = fullPath;
  if (resolved) {
    span.setAttribute(PATH_ATTR, resolved);
    if (line !== null) span.setAttribute(LINE_ATTR, String(line));
    span.setAttribute("role", "button");
    span.setAttribute("tabindex", "0");
  }

  span.appendChild(createFileGlyph(fullPath, "mention-ref-icon"));

  const text = document.createElement("span");
  text.className = "mention-ref-text";
  text.textContent = basename(fullPath);
  span.appendChild(text);
  return span;
}

/** Replace `@path` tokens inside one text node with pill spans. */
function decorateTextNode(textNode: Text, files: ReadonlyArray<ReviewFile>): void {
  const value = textNode.nodeValue ?? "";
  MENTION_RE.lastIndex = 0;
  if (!MENTION_RE.test(value)) return;
  MENTION_RE.lastIndex = 0;

  const frag = document.createDocumentFragment();
  let last = 0;
  let match: RegExpExecArray | null = MENTION_RE.exec(value);
  while (match) {
    const [whole, path, lineStr] = match;
    if (match.index > last) frag.append(value.slice(last, match.index));
    frag.append(makePill(path ?? "", lineStr ? Number(lineStr) : null, files));
    last = match.index + whole.length;
    match = MENTION_RE.exec(value);
  }
  if (last < value.length) frag.append(value.slice(last));
  textNode.replaceWith(frag);
}

function decorate(node: HTMLElement, files: ReadonlyArray<ReviewFile> | null): void {
  if (!files) {
    for (const pill of node.querySelectorAll<HTMLElement>(`.${PILL_CLASS}`)) {
      pill.replaceWith(document.createTextNode(`@${pill.title}`));
    }
    return;
  }
  // Collect text nodes first (the walk and the mutation must not interleave).
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || el.closest(`.${PILL_CLASS}`) || el.closest("pre") || el.closest("code")) continue;
    if ((n.nodeValue ?? "").includes("@")) texts.push(n as Text);
  }
  for (const t of texts) decorateTextNode(t, files);
}

/**
 * The bound value IS the review file set (or `null`/`false` to disable). It
 * gates decoration AND carries the data resolution uses — passing a fresh array
 * on each render is what re-runs `update` so pills track the live file set for
 * clickability. There is no hidden second signal.
 */
export const mentionReferences: Action<
  HTMLElement,
  ReadonlyArray<ReviewFile> | null | false | undefined
> = (node, value) => {
  let destroyed = false;
  let scheduled = false;
  let files: ReadonlyArray<ReviewFile> | null = value || null;

  const schedule = (): void => {
    if (destroyed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (destroyed) return;
      observer.disconnect();
      decorate(node, files);
      if (!destroyed) observer.observe(node, { childList: true, subtree: true });
    });
  };

  const activate = (target: EventTarget | null): void => {
    const pill = (target as HTMLElement | null)?.closest<HTMLElement>(`.${PILL_CLASS}`);
    if (!pill || !node.contains(pill)) return;
    const path = pill.getAttribute(PATH_ATTR);
    if (!path) return;
    const lineAttr = pill.getAttribute(LINE_ATTR);
    openFileInDiff(path, lineAttr ? Number(lineAttr) : undefined);
  };

  const onClick = (e: MouseEvent): void => {
    if (!files) return;
    const pill = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      `.${PILL_CLASS}[${PATH_ATTR}]`,
    );
    if (!pill || !node.contains(pill)) return;
    e.preventDefault();
    activate(e.target);
  };

  const onKeydown = (e: KeyboardEvent): void => {
    if (!files || (e.key !== "Enter" && e.key !== " ")) return;
    const pill = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      `.${PILL_CLASS}[${PATH_ATTR}]`,
    );
    if (!pill || !node.contains(pill)) return;
    e.preventDefault();
    activate(e.target);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(node, { childList: true, subtree: true });
  node.addEventListener("click", onClick);
  node.addEventListener("keydown", onKeydown);
  schedule();

  return {
    update(next) {
      files = next || null;
      schedule();
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
      node.removeEventListener("click", onClick);
      node.removeEventListener("keydown", onKeydown);
    },
  };
};
