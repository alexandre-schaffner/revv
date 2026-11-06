import pierreDark from "@pierre/theme/pierre-dark";
import pierreLight from "@pierre/theme/pierre-light";
import { PIERRE_THEME } from "@revv/shared";
import { createHighlighter, type Highlighter } from "shiki";

let highlighter: Highlighter | null = null;
let loading: Promise<void> | null = null;
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

/** Reactive: a render that read it re-runs once Shiki has loaded. */
export function isHighlighterReady(): boolean {
  return ready;
}

function load(): void {
  if (loading) return;
  // Deep-clone frozen Pierre theme objects so Shiki's mutable ThemeInput
  // type accepts them (removes Readonly<> wrappers at every level).
  loading = createHighlighter({
    themes: [JSON.parse(JSON.stringify(pierreDark)), JSON.parse(JSON.stringify(pierreLight))],
    langs: PRELOAD_LANGS,
  }).then(
    (loaded) => {
      highlighter = loaded;
      ready = true;
    },
    () => {
      loading = null;
    },
  );
}

/**
 * Highlighted HTML for a fenced block, or null for plain `<pre>`: an unknown
 * language, or Shiki not loaded yet. The first fence asks for Shiki to load.
 */
export function highlightCode(code: string, lang: string): string | null {
  if (!highlighter) {
    load();
    return null;
  }
  const normalized = lang.toLowerCase();
  if (!highlighter.getLoadedLanguages().includes(normalized)) return null;
  try {
    return highlighter.codeToHtml(code, { lang: normalized, themes: PIERRE_THEME });
  } catch {
    return null;
  }
}
