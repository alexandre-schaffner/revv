// Server-side rendering of the PR files list's first diff (`GET /api/prs/:id/files`):
// the client hydrates it instead of tokenizing on its worker. Renders inline
// (Highlights is fast once the shared highlighter is warm) and memoizes the HTML
// in an LRU; every miss re-renders from its inputs, so the cache is reconstructible.

import { Buffer } from "node:buffer";
import type { DiffLineAnnotation, FileDiffOptions } from "@pierre/diffs";
import { preloadHighlighter } from "@pierre/diffs";
import { preloadPatchDiff, preloadPatchFile } from "@pierre/diffs/ssr";
import {
  buildGitPatchHeader,
  type CommentThread,
  PIERRE_DIFF_PRELOAD_LANGS,
  PIERRE_HIGHLIGHTER,
  PIERRE_THEMES,
  PR_DIFF_RENDER_OPTIONS,
  type PrDiffRenderOptions,
  threadAnnotationPosition,
} from "@revv/shared";
import { logError } from "../logger";
import type { CachedDiffFile } from "./DiffCache";

export const SSR_PATCH_BYTE_LIMIT = 256 * 1024;
export const SSR_PATCH_LINE_LIMIT = 6_000;

/** The web viewer renders with the same options, or the hydrated HTML mismatches. */
const SSR_OPTIONS: Pick<
  FileDiffOptions<unknown, undefined>,
  keyof PrDiffRenderOptions
> = PR_DIFF_RENDER_OPTIONS;
const SSR_OPTIONS_KEY = Bun.hash(JSON.stringify(SSR_OPTIONS)).toString(36);

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

let highlighterReady: Promise<void> | null = null;

/** Idempotent. Called at server boot and again by every prerender. */
export function ensureHighlighter(): Promise<void> {
  if (highlighterReady === null) {
    highlighterReady = preloadHighlighter({
      themes: [...PIERRE_THEMES],
      langs: [...PIERRE_DIFF_PRELOAD_LANGS],
      preferredHighlighter: PIERRE_HIGHLIGHTER,
    });
  }
  return highlighterReady;
}

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

const htmlCache = new LruCache<string>(1000);

/** The patch's first file rendered, or null when it can't be parsed. */
async function prerenderDiff(
  patch: string,
  annotations: DiffLineAnnotation<unknown>[],
): Promise<string | null> {
  if (!canPrerenderPatch(patch)) return null;

  await ensureHighlighter();

  const annotationKey = annotations.length > 0 ? JSON.stringify(annotations) : "";
  const key = `${Bun.hash(`${patch}\0${annotationKey}`).toString(36)}:${SSR_OPTIONS_KEY}`;
  const cached = htmlCache.get(key);
  if (cached !== undefined) return cached;

  const html =
    annotations.length > 0
      ? (await preloadPatchDiff({ patch, options: SSR_OPTIONS, annotations })).prerenderedHTML
      : (await preloadPatchFile({ patch, options: SSR_OPTIONS }))[0]?.prerenderedHTML;
  if (html === undefined) return null;

  htmlCache.set(key, html);
  return html;
}

function prFilePatch(file: CachedDiffFile, patch: string): string {
  const header = buildGitPatchHeader({
    path: file.path,
    oldPath: file.oldPath,
    isNew: file.status === "added",
    isDeleted: file.status === "removed",
  });
  return `${header}\n${patch}`;
}

/**
 * The prerendered HTML, or undefined when the file has no patch (binary),
 * exceeds the SSR guardrails, or rendering failed: the client renders it then.
 */
async function prerenderPrFile(
  file: CachedDiffFile,
  threads: readonly CommentThread[],
): Promise<string | undefined> {
  if (file.patch === null) return undefined;
  try {
    const annotations = threads
      .filter((thread) => thread.filePath === file.path)
      .map((thread) => ({ ...threadAnnotationPosition(thread), metadata: null }));
    return (await prerenderDiff(prFilePatch(file, file.patch), annotations)) ?? undefined;
  } catch (err) {
    logError("pr-files-prerender", `prerender failed for ${file.path}:`, err);
    return undefined;
  }
}

/**
 * The PR files list, with the active file (else the first) server-rendered.
 * Only one: Shiki tokenization is synchronous CPU work, so rendering every
 * file would make a cold request scale with the whole PR.
 */
export async function prFilesWithPrerender(
  files: readonly CachedDiffFile[],
  threads: readonly CommentThread[],
  activePath: string | undefined,
) {
  const prerenderPath =
    activePath !== undefined && files.some((file) => file.path === activePath)
      ? activePath
      : (files[0]?.path ?? null);
  return Promise.all(
    files.map(async (f) => {
      const prerenderedHtml =
        f.path === prerenderPath ? await prerenderPrFile(f, threads) : undefined;
      return {
        path: f.path,
        oldPath: f.oldPath,
        patch: f.patch,
        additions: f.additions,
        deletions: f.deletions,
        isNew: f.status === "added",
        isDeleted: f.status === "removed",
        ...(prerenderedHtml ? { prerenderedHtml } : {}),
      };
    }),
  );
}
