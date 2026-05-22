import type { FileDiffOptions, FileOptions } from "@pierre/diffs";
import { preloadHighlighter } from "@pierre/diffs";
import { preloadFile, preloadPatchFile } from "@pierre/diffs/ssr";

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

/**
 * Same languages the client worker pool preloads
 * (apps/web/src/lib/utils/worker-pool.ts:14-27). Keeping the lists in sync
 * means the SSR HTML lines up byte-for-byte with what the client would
 * produce on a cold render.
 */
const PRELOAD_LANGS = [
  "typescript",
  "javascript",
  "svelte",
  "css",
  "json",
  "python",
  "go",
  "rust",
  "html",
  "shellscript",
  "yaml",
  "sql",
] as const;

const PRELOAD_THEMES = ["pierre-dark", "pierre-light"] as const;

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
      themes: [...PRELOAD_THEMES],
      langs: [...PRELOAD_LANGS],
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
const fileCache = new LruCache<string>(CACHE_MAX_ENTRIES);

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
  FileDiffOptions<never>,
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

export type SsrFileOptions = Pick<FileOptions<never>, "theme" | "disableFileHeader" | "overflow">;

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
): Promise<string | null> {
  await ensureHighlighter();

  const optionsKey = stableOptionsKey(options);
  const key = cacheKey(patch, optionsKey);
  const cached = diffCache.get(key);
  if (cached !== undefined) return cached;

  const results = await preloadPatchFile({ patch, options });
  const html = results[0]?.prerenderedHTML;
  if (html === undefined) return null;

  diffCache.set(key, html);
  return html;
}

/**
 * Render a single code file (no diff) to HTML via `preloadFile`. Used for
 * walkthrough `CodeBlock`s.
 */
export async function prerenderFile(
  file: { name: string; contents: string; lang: string },
  options: SsrFileOptions,
): Promise<string | null> {
  await ensureHighlighter();

  const optionsKey = stableOptionsKey(options);
  const key = cacheKey(`${file.lang}\0${file.name}\0${file.contents}`, optionsKey);
  const cached = fileCache.get(key);
  if (cached !== undefined) return cached;

  const result = await preloadFile({ file, options });
  const html = result.prerenderedHTML;
  if (html === undefined) return null;

  fileCache.set(key, html);
  return html;
}
