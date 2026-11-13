import { MENTION_PATH_PATTERN } from "@revv/shared";
import { decorationAction } from "$lib/markdown/decorate";
import type { ReviewFile } from "$lib/stores/diff-files.svelte";
import { openInDiff } from "$lib/stores/review-nav.svelte";
import { basename } from "$lib/utils/path";
import { appendPillContents } from "./file-glyph";
import type { ReviewFilesScope } from "./file-references";

const PILL_CLASS = "mention-ref";
const PATH_ATTR = "data-mention-path";
const LINE_ATTR = "data-mention-line";

// Shared with the composer. Requires an extension so a prose `@handle` isn't captured.
const MENTION_RE = new RegExp(MENTION_PATH_PATTERN, "g");

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

/**
 * Idempotent; reruns on every re-decoration so a pill minted before the file set
 * loaded becomes clickable later. The pill's `title` (full path) and
 * `data-mention-line` are its only record of the original `@token`.
 */
function syncPill(pill: HTMLElement, files: ReadonlyArray<ReviewFile>): void {
  const resolved = resolvePath(pill.title, files);
  if (resolved) {
    pill.setAttribute(PATH_ATTR, resolved);
    pill.setAttribute("role", "button");
    pill.setAttribute("tabindex", "0");
  } else {
    pill.removeAttribute(PATH_ATTR);
    pill.removeAttribute("role");
    pill.removeAttribute("tabindex");
  }
}

function makePill(
  fullPath: string,
  line: number | null,
  files: ReadonlyArray<ReviewFile>,
): HTMLElement {
  const span = document.createElement("span");
  span.className = PILL_CLASS;
  span.title = fullPath;
  if (line !== null) span.setAttribute(LINE_ATTR, String(line));

  appendPillContents(span, fullPath, "mention-ref-icon", "mention-ref-text");

  syncPill(span, files);
  return span;
}

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
  for (const pill of node.querySelectorAll<HTMLElement>(`.${PILL_CLASS}`)) {
    syncPill(pill, files);
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
 * The bound value is the review's file set, or null to leave the mentions as
 * text. A new file set re-resolves which pills are clickable.
 */
export const mentionReferences = decorationAction<ReviewFilesScope | null>((node) => {
  let scope: ReviewFilesScope | null = null;

  const target = (e: Event): HTMLElement | null => {
    if (!scope) return null;
    const pill = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      `.${PILL_CLASS}[${PATH_ATTR}]`,
    );
    return pill && node.contains(pill) ? pill : null;
  };
  const activate = (e: Event): void => {
    const pill = target(e);
    const path = pill?.getAttribute(PATH_ATTR);
    if (!pill || !path || !scope) return;
    e.preventDefault();
    const lineAttr = pill.getAttribute(LINE_ATTR);
    openInDiff(scope.prId, path, lineAttr ? Number(lineAttr) : undefined);
  };
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") activate(e);
  };
  node.addEventListener("click", activate);
  node.addEventListener("keydown", onKeydown);

  return {
    apply(next) {
      scope = next;
      decorate(node, scope?.files ?? null);
    },
    destroy() {
      node.removeEventListener("click", activate);
      node.removeEventListener("keydown", onKeydown);
    },
  };
});
