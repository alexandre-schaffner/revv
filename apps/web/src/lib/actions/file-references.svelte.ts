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
//
// Follows the `mermaidDiagrams` action pattern: a MutationObserver re-decorates
// on content changes (streaming), microtask-scheduled so it runs after Svelte
// patches the DOM. Attribute writes aren't observed (childList only), so our own
// decoration never re-triggers the observer.

import type { Action } from "svelte/action";

import { getReviewFiles, openFileInDiff } from "$lib/stores/review.svelte";

const REF_PATH_ATTR = "data-file-ref-path";
const REF_LINE_ATTR = "data-file-ref-line";
const REF_CLASS = "file-ref";

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

function buildLookup(): FileLookup {
  const paths = new Set<string>();
  const byBasename = new Map<string, Set<string>>();
  for (const file of getReviewFiles()) {
    for (const p of [file.path, file.oldPath]) {
      if (!p) continue;
      paths.add(p);
      const base = p.slice(p.lastIndexOf("/") + 1);
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
  const base = candidate.slice(candidate.lastIndexOf("/") + 1);
  const owners = lookup.byBasename.get(base);
  if (!owners || owners.size !== 1) return null;
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
}

function decorate(node: HTMLElement, enabled: boolean): void {
  if (!enabled) {
    for (const code of node.querySelectorAll<HTMLElement>(`code.${REF_CLASS}`)) undecorate(code);
    return;
  }
  const lookup = buildLookup();
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
 * Bound value gates the action: a truthy value (the current review file set)
 * enables decoration, a falsy value (`null`/`false`) leaves the markdown inert.
 * The value also re-triggers `update` so decoration tracks the live file set.
 */
export const fileReferences: Action<HTMLElement, unknown> = (node, value) => {
  let destroyed = false;
  let scheduled = false;
  let enabled = Boolean(value);

  const schedule = (): void => {
    if (destroyed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!destroyed) decorate(node, enabled);
    });
  };

  const onClick = (e: MouseEvent): void => {
    if (!enabled) return;
    const ref = (e.target as HTMLElement | null)?.closest<HTMLElement>(`.${REF_CLASS}`);
    if (!ref || !node.contains(ref)) return;
    e.preventDefault();
    open(ref);
  };

  const onKeydown = (e: KeyboardEvent): void => {
    if (!enabled || (e.key !== "Enter" && e.key !== " ")) return;
    const ref = (e.target as HTMLElement | null)?.closest<HTMLElement>(`.${REF_CLASS}`);
    if (!ref || !node.contains(ref)) return;
    e.preventDefault();
    open(ref);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(node, { childList: true, subtree: true });
  node.addEventListener("click", onClick);
  node.addEventListener("keydown", onKeydown);
  schedule();

  return {
    // Re-decorate when the bound value (the current file set) changes.
    update(next) {
      enabled = Boolean(next);
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
