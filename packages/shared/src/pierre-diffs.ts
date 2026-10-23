export const PIERRE_DIFF_PRELOAD_LANGS = [
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

export const PIERRE_THEME = { dark: "pierre-dark", light: "pierre-light" } as const;
export const PIERRE_THEMES = [PIERRE_THEME.dark, PIERRE_THEME.light] as const;

// Pierre's WebAssembly lexers instead of Shiki: same themes, a fraction of the
// cost. A process runs one backend at a time, so the server's SSR highlighter
// and the web worker pool must agree, or hydrated diffs re-tokenize.
export const PIERRE_HIGHLIGHTER = "highlights";

export type PrDiffRenderOptions = {
  readonly diffStyle: "unified";
  readonly theme: typeof PIERRE_THEME;
  readonly overflow: "scroll";
  readonly expansionLineCount: number;
  readonly collapsedContextThreshold: number;
  readonly diffIndicators: "bars";
  readonly expandUnchanged: boolean;
  readonly lineHoverHighlight: "both";
  readonly hunkSeparators: "line-info";
  readonly preferredHighlighter: typeof PIERRE_HIGHLIGHTER;
};

export const PR_DIFF_RENDER_OPTIONS: PrDiffRenderOptions = {
  diffStyle: "unified",
  theme: PIERRE_THEME,
  overflow: "scroll",
  expansionLineCount: 20,
  collapsedContextThreshold: 3,
  diffIndicators: "bars",
  // PR files are patch-only (no full contents), so there is nothing to expand.
  // Pierre 1.5+ treats `true` as "load both files and expand everything" and
  // throws without a `loadDiffFiles` loader.
  expandUnchanged: false,
  lineHoverHighlight: "both",
  hunkSeparators: "line-info",
  preferredHighlighter: PIERRE_HIGHLIGHTER,
} as const;

export interface GitPatchHeaderFile {
  path: string;
  oldPath?: string | null;
  isNew?: boolean;
  isDeleted?: boolean;
}

export function buildGitPatchHeader(file: GitPatchHeaderFile): string {
  const oldPath = file.oldPath ?? file.path;
  return [
    `diff --git a/${oldPath} b/${file.path}`,
    ...(file.isNew ? ["new file mode 100644"] : []),
    ...(file.isDeleted ? ["deleted file mode 100644"] : []),
    `--- ${file.isNew ? "/dev/null" : `a/${oldPath}`}`,
    `+++ ${file.isDeleted ? "/dev/null" : `b/${file.path}`}`,
  ].join("\n");
}
