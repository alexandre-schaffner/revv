// The chat agent writes file paths as inline code (`user.service.ts`,
// `src/bar.ts:42`). A token becomes a link to the diff only when it
// unambiguously matches a changed file: a basename several changed files share
// stays inert, and so does a symbol in backticks (`checkAccessBatch`).

import { decorationAction } from "$lib/markdown/decorate";
import type { ReviewFile } from "$lib/stores/diff-files.svelte";
import { openFileInDiff } from "$lib/stores/review-nav.svelte";
import { basename } from "$lib/utils/path";
import { createFileGlyph } from "./file-glyph";

const REF_PATH_ATTR = "data-file-ref-path";
const REF_LINE_ATTR = "data-file-ref-line";
const REF_CLASS = "file-ref";
const ICON_CLASS = "file-ref-icon";

function ensureIcon(code: HTMLElement, path: string): void {
  if (code.querySelector(`.${ICON_CLASS}`)) return;
  code.prepend(createFileGlyph(path, ICON_CLASS));
}

interface ResolvedRef {
  path: string;
  line: number | null;
}

interface FileLookup {
  paths: Set<string>;
  byBasename: Map<string, Set<string>>;
}

function buildLookup(files: ReadonlyArray<ReviewFile>): FileLookup {
  const paths = new Set<string>();
  const byBasename = new Map<string, Set<string>>();
  for (const file of files) {
    for (const p of [file.path, file.oldPath]) {
      if (!p) continue;
      paths.add(p);
      const base = basename(p);
      let set = byBasename.get(base);
      if (!set) {
        set = new Set();
        byBasename.set(base, set);
      }
      set.add(file.path);
    }
  }
  return { paths, byBasename };
}

/**
 * Split a `path[:line[:col]]` token into a candidate path and optional line.
 * Only a purely-numeric suffix is treated as a line; `foo.ts:bar()` keeps its
 * whole text as the path (and so won't resolve).
 */
function splitToken(raw: string): { candidate: string; line: number | null } {
  const trimmed = raw.trim().replace(/^\.\//, "");
  const match = trimmed.match(/^(.+?):(\d+)(?::\d+)?$/);
  if (match?.[1] && match[2]) {
    return { candidate: match[1].replace(/^\.\//, ""), line: Number(match[2]) };
  }
  return { candidate: trimmed, line: null };
}

function resolveRef(raw: string, lookup: FileLookup): ResolvedRef | null {
  const { candidate, line } = splitToken(raw);
  if (!candidate) return null;

  if (lookup.paths.has(candidate)) return { path: candidate, line };

  const base = basename(candidate);
  const owners = lookup.byBasename.get(base);
  if (owners?.size !== 1) return null;
  const [only] = owners;
  if (!only) return null;
  if (candidate === base || only.endsWith(`/${candidate}`)) return { path: only, line };
  return null;
}

function undecorate(code: HTMLElement): void {
  code.classList.remove(REF_CLASS);
  code.removeAttribute(REF_PATH_ATTR);
  code.removeAttribute(REF_LINE_ATTR);
  code.removeAttribute("role");
  code.removeAttribute("tabindex");
  code.removeAttribute("title");
  code.querySelector(`.${ICON_CLASS}`)?.remove();
}

function decorate(node: HTMLElement, files: ReadonlyArray<ReviewFile> | null): void {
  if (!files) {
    for (const code of node.querySelectorAll<HTMLElement>(`code.${REF_CLASS}`)) undecorate(code);
    return;
  }
  const lookup = buildLookup(files);
  const codes = node.querySelectorAll<HTMLElement>("code");
  for (const code of codes) {
    if (code.closest("pre")) continue;
    const ref = resolveRef(code.textContent ?? "", lookup);
    if (ref) {
      code.classList.add(REF_CLASS);
      code.setAttribute(REF_PATH_ATTR, ref.path);
      if (ref.line !== null) code.setAttribute(REF_LINE_ATTR, String(ref.line));
      else code.removeAttribute(REF_LINE_ATTR);
      code.setAttribute("role", "button");
      code.setAttribute("tabindex", "0");
      code.setAttribute("title", `Open ${ref.path} in diff`);
      ensureIcon(code, ref.path);
    } else if (code.classList.contains(REF_CLASS)) {
      undecorate(code);
    }
  }
}

function open(target: HTMLElement): void {
  const path = target.getAttribute(REF_PATH_ATTR);
  if (!path) return;
  const lineAttr = target.getAttribute(REF_LINE_ATTR);
  const line = lineAttr ? Number(lineAttr) : undefined;
  openFileInDiff(path, line);
}

/**
 * The bound value is the review's file set, or null to leave the markdown
 * inert. A new file set re-decorates.
 */
export const fileReferences = decorationAction<ReadonlyArray<ReviewFile> | null>((node) => {
  let files: ReadonlyArray<ReviewFile> | null = null;

  const target = (e: Event): HTMLElement | null => {
    if (!files) return null;
    const ref = (e.target as HTMLElement | null)?.closest<HTMLElement>(`.${REF_CLASS}`);
    return ref && node.contains(ref) ? ref : null;
  };
  const onClick = (e: MouseEvent): void => {
    const ref = target(e);
    if (!ref) return;
    e.preventDefault();
    open(ref);
  };
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const ref = target(e);
    if (!ref) return;
    e.preventDefault();
    open(ref);
  };
  node.addEventListener("click", onClick);
  node.addEventListener("keydown", onKeydown);

  return {
    apply(next) {
      files = next;
      decorate(node, files);
    },
    destroy() {
      node.removeEventListener("click", onClick);
      node.removeEventListener("keydown", onKeydown);
    },
  };
});
