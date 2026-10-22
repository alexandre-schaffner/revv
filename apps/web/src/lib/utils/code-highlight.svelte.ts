import pierreDark from "@pierre/theme/pierre-dark";
import pierreLight from "@pierre/theme/pierre-light";
import { PIERRE_THEME } from "@revv/shared";
import { createHighlighter, type Highlighter } from "shiki";

let highlighter: Highlighter | null = null;
let initPromise: Promise<Highlighter> | null = null;
let ready = $state(false);

const PRELOAD_LANGS = [
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "python",
  "ruby",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "css",
  "scss",
  "html",
  "json",
  "yaml",
  "toml",
  "xml",
  "sql",
  "bash",
  "shellscript",
  "diff",
  "markdown",
  "swift",
  "kotlin",
  "php",
  "lua",
  "zig",
  "elixir",
  "haskell",
  "ocaml",
  "svelte",
  "vue",
  "dockerfile",
  "graphql",
  "proto",
];

export function isHighlighterReady(): boolean {
  return ready;
}

export async function initHighlighter(): Promise<void> {
  if (highlighter) return;
  if (!initPromise) {
    // Deep-clone frozen Pierre theme objects so Shiki's mutable ThemeInput
    // type accepts them (removes Readonly<> wrappers at every level).
    initPromise = createHighlighter({
      themes: [JSON.parse(JSON.stringify(pierreDark)), JSON.parse(JSON.stringify(pierreLight))],
      langs: PRELOAD_LANGS,
    });
  }
  highlighter = await initPromise;
  ready = true;
}

export function highlightCode(code: string, lang: string): string | null {
  if (!highlighter) return null;

  try {
    const loaded = highlighter.getLoadedLanguages();
    const normalized = lang.toLowerCase();
    if (!loaded.includes(normalized)) return null;

    return highlighter.codeToHtml(code, {
      lang: normalized,
      themes: PIERRE_THEME,
    });
  } catch {
    return null;
  }
}
