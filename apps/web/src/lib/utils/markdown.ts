import DOMPurify from "dompurify";
import { marked } from "marked";
import { highlightCode } from "./code-highlight.svelte";

marked.setOptions({
  breaks: true,
  gfm: true,
});

marked.use({
  hooks: {
    // Wrap every rendered table in a scroll container so wide tables don't
    // blow out narrow panels. Styled globally via `.prose-table` in app.css.
    // Safe because the custom code renderer escapes `<` to `&lt;` — real
    // `<table>` tags only appear for actually-rendered GFM tables.
    postprocess(html: string): string {
      return html
        .replace(/<table([\s>])/g, '<div class="prose-table" tabindex="0"><table$1')
        .replace(/<\/table>/g, "</table></div>");
    },
  },
  renderer: {
    code({ text, lang }) {
      if (lang) {
        const highlighted = highlightCode(text, lang);
        if (highlighted) return highlighted;
      }
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const langClass = lang ? ` class="language-${lang}"` : "";
      return `<pre><code${langClass}>${escaped}</code></pre>`;
    },
  },
});

export function renderMarkdown(source: string): string {
  // Normalize literal \n escape sequences (AI output artefact) to real newlines
  // so that marked sees actual paragraph breaks instead of two-character text.
  const normalized = source.replace(/\\n/g, "\n");
  const raw = marked.parse(normalized, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ["style", "class", "tabindex"],
  });
}
