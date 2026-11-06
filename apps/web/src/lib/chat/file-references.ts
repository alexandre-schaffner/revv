// ── Clickable file references in chat markdown ──────────────────────────────
//
// The chat agent writes file paths as inline code (`apps/web/src/foo.ts`,
// `user.service.ts`, `src/bar.ts:42`). This action walks rendered markdown
// after each `{@html}` update, and for every inline `<code>` whose text
// resolves to a file in the current review, turns it into a clickable
// reference that opens the file in the diff tab (scrolling to the line when the
// token carries one).
//
// Resolution is intentionally conservative: a token only becomes a link when it
// unambiguously matches a changed file. A bare basename that several changed
// files share stays inert rather than guessing the wrong target. This keeps the
// common "symbol in backticks" (`checkAccessBatch`) from masquerading as a file.

import { decorationAction } from "$lib/markdown/decorate";
import { openFileInDiff } from "$lib/stores/review-nav.svelte";
import type { ReviewFile } from "$lib/types/review";
import { createFileGlyph } from "$lib/utils/file-glyph";
import { basename } from "$lib/utils/path";

const REF_PATH_ATTR = "data-file-ref-path";
const REF_LINE_ATTR = "data-file-ref-line";
const REF_CLASS = "file-ref";
const ICON_CLASS = "file-ref-icon";

/** Prepend the per-extension file-type glyph into a resolved reference once. */
function ensureIcon(code: HTMLElement, path: string): void {
  if (code.querySelector(`.${ICON_CLASS}`)) return;
  code.prepend(createFileGlyph(path, ICON_CLASS));
}

interface ResolvedRef {
  path: string;
  line: number | null;
}

interface FileLookup {
  /** Exact path / oldPath membership. */
  paths: Set<string>;
  /** Basename → set of full paths ending in that basename (ambiguity guard). */
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

/** Resolve a code token to a changed file, or null when no unambiguous match. */
function resolveRef(raw: string, lookup: FileLookup): ResolvedRef | null {
  const { candidate, line } = splitToken(raw);
  if (!candidate) return null;

  // Exact full-path match wins outright.
  if (lookup.paths.has(candidate)) return { path: candidate, line };

  // Otherwise fall back to a unique basename match so a bare `foo.ts` resolves
  // to `src/foo.ts` — but only when exactly one changed file owns that name.
  const base = basename(candidate);
  const owners = lookup.byBasename.get(base);
  if (owners?.size !== 1) return null;
  const [only] = owners;
  if (!only) return null;
  // A path-bearing candidate (`a/foo.ts`) must be a suffix of the real path to
  // count — guards against `b/foo.ts` linking to `a/foo.ts`.
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
    // Inline code only — skip fenced/highlighted blocks (`<pre><code>`).
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
      // A prior render matched but the file set changed — strip the affordance.
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
