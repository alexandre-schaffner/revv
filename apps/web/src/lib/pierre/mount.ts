// Static Pierre blocks: rendered once, with no interaction, inside our own
// card chrome.

import {
  DIFFS_TAG_NAME,
  type FileContents,
  type FileDiffMetadata,
  File as PierreFile,
  FileDiff as PierreFileDiff,
  type RenderRange,
} from "@pierre/diffs";
import { PIERRE_THEME } from "@revv/shared";
import type { ActionReturn } from "svelte/action";
import { workerManager } from "./worker-pool";

/**
 * The shadow host Pierre's `render` creates itself; `hydrate` needs one made
 * for it. It must be this custom element: app.css gives `diffs-container`
 * `color-scheme: inherit`, so Pierre's `light-dark()` token colors follow the
 * app's theme rather than the OS's.
 */
export function createDiffsHost(): HTMLElement {
  return document.createElement(DIFFS_TAG_NAME);
}

export interface PierreFileParams {
  file: FileContents;
  /** Server-rendered HTML (`@pierre/diffs/ssr`) to hydrate instead of tokenizing on the worker. */
  prerenderedHtml?: string | undefined;
  /** Render only this window of the file; the gutter keeps absolute line numbers. */
  renderRange?: RenderRange | undefined;
  onPostRender?: ((node: HTMLElement) => void) | undefined;
}

export function pierreFile(
  el: HTMLElement,
  params: PierreFileParams,
): ActionReturn<PierreFileParams> {
  const instance = new PierreFile<never>(
    {
      theme: PIERRE_THEME,
      overflow: "scroll",
      disableFileHeader: true,
      ...(params.onPostRender ? { onPostRender: params.onPostRender } : {}),
    },
    workerManager,
  );
  if (params.prerenderedHtml !== undefined) {
    const host = createDiffsHost();
    el.appendChild(host);
    instance.hydrate({
      fileContainer: host,
      prerenderedHTML: params.prerenderedHtml,
      file: params.file,
    });
  } else {
    instance.render({
      containerWrapper: el,
      file: params.file,
      ...(params.renderRange ? { renderRange: params.renderRange } : {}),
    });
  }
  return { destroy: () => instance.cleanUp() };
}

export type PierreDiffParams =
  | { fileDiff: FileDiffMetadata; prerenderedHtml?: string | undefined }
  | { oldFile: FileContents; newFile: FileContents };

export function pierreDiff(
  el: HTMLElement,
  params: PierreDiffParams,
): ActionReturn<PierreDiffParams> {
  const instance = new PierreFileDiff<never>(
    { diffStyle: "unified", theme: PIERRE_THEME, overflow: "scroll", disableFileHeader: true },
    workerManager,
  );
  if ("oldFile" in params) {
    instance.render({ containerWrapper: el, oldFile: params.oldFile, newFile: params.newFile });
  } else if (params.prerenderedHtml !== undefined) {
    const host = createDiffsHost();
    el.appendChild(host);
    instance.hydrate({
      fileContainer: host,
      prerenderedHTML: params.prerenderedHtml,
      fileDiff: params.fileDiff,
    });
  } else {
    instance.render({ containerWrapper: el, fileDiff: params.fileDiff });
  }
  return { destroy: () => instance.cleanUp() };
}
