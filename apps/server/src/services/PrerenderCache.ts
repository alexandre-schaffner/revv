import { Buffer } from "node:buffer";
import type { DiffLineAnnotation, FileDiffOptions } from "@pierre/diffs";
import { preloadHighlighter } from "@pierre/diffs";
import { preloadPatchDiff, preloadPatchFile } from "@pierre/diffs/ssr";
import { PIERRE_DIFF_PRELOAD_LANGS, PIERRE_THEMES } from "@revv/shared";

/**
 * Server-side SSR cache for `@pierre/diffs`. Calls `preloadPatchFile` /
 * `preloadFile` inline (Shiki is fast once the shared highlighter is warm)
 * and memoizes the rendered HTML in an LRU.
 *
 * No DB, no Effect service — these are plain async functions consumed by
 * the PR files endpoint. State is reconstructible: every miss re-renders
 * from the inputs.
 */

// ── Defaults ────────────────────────────────────────────────────────────────

export const SSR_PATCH_BYTE_LIMIT = 256 * 1024;
export const SSR_PATCH_LINE_LIMIT = 6_000;

function lineCountWithinLimit(content: string, limit: number): boolean {
  let lines = content.length === 0 ? 0 : 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      lines++;
      if (lines > limit) return false;
    }
  }
  return true;
}

function canPrerenderPatch(patch: string): boolean {
  return (
    Buffer.byteLength(patch, "utf8") <= SSR_PATCH_BYTE_LIMIT &&
    lineCountWithinLimit(patch, SSR_PATCH_LINE_LIMIT)
  );
}

// ── Highlighter priming ─────────────────────────────────────────────────────

let highlighterReady: Promise<void> | null = null;

/**
 * Idempotent. First call kicks off `preloadHighlighter`; concurrent callers
 * await the same promise so we don't spin up Shiki twice. Called at server
 * boot and defensively at the top of each prerender call (boot might still
 * be racing the first walkthrough emit).
 */
export function ensureHighlighter(): Promise<void> {
  if (highlighterReady === null) {
    highlighterReady = preloadHighlighter({
      themes: [...PIERRE_THEMES],
      langs: [...PIERRE_DIFF_PRELOAD_LANGS],
    });
  }
  return highlighterReady;
}

// ── LRU ─────────────────────────────────────────────────────────────────────

class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }
}

const CACHE_MAX_ENTRIES = 1000;
const diffCache = new LruCache<string>(CACHE_MAX_ENTRIES);

function cacheKey(content: string, optionsKey: string): string {
  return `${Bun.hash(content).toString(36)}:${optionsKey}`;
}

function stableOptionsKey(options: object): string {
  return Bun.hash(JSON.stringify(options, Object.keys(options).sort())).toString(36);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Options for SSR diff rendering. Subset of `FileDiffOptions` containing only
 * the serializable structural fields that affect rendered HTML — callbacks
 * and DOM-producing fields stay client-side where they belong.
 */
export type SsrDiffOptions = Pick<
  FileDiffOptions<unknown>,
  | "diffStyle"
  | "theme"
  | "disableFileHeader"
  | "hunkSeparators"
  | "expansionLineCount"
  | "collapsedContextThreshold"
  | "diffIndicators"
  | "expandUnchanged"
  | "lineHoverHighlight"
  | "overflow"
>;

/**
 * Render a unified diff patch to HTML via `preloadPatchFile`. Returns the
 * prerendered HTML for the first file in the patch (walkthrough blocks and
 * PR file rows are single-file by construction).
 *
 * Returns `null` if the patch can't be parsed — caller falls back to
 * client-side rendering.
 */
export async function prerenderDiff(
  patch: string,
  options: SsrDiffOptions,
  annotations?: DiffLineAnnotation<unknown>[],
): Promise<string | null> {
  if (!canPrerenderPatch(patch)) return null;

  await ensureHighlighter();

  const optionsKey = stableOptionsKey(options);
  const annotationKey = annotations && annotations.length > 0 ? JSON.stringify(annotations) : "";
  const key = cacheKey(`${patch}\0${annotationKey}`, optionsKey);
  const cached = diffCache.get(key);
  if (cached !== undefined) return cached;

  const html =
    annotations && annotations.length > 0
      ? (await preloadPatchDiff({ patch, options, annotations })).prerenderedHTML
      : (await preloadPatchFile({ patch, options }))[0]?.prerenderedHTML;
  if (html === undefined) return null;

  diffCache.set(key, html);
  return html;
}
