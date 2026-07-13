import DOMPurify from "dompurify";
import { marked } from "marked";
import remend from "remend";
import { highlightCode } from "./code-highlight.svelte";
import { debugLog, debugLogEnabled } from "./debug-log";

// Diagnostic counters (REV_DEBUG only): a runaway `renderMarkdown` call rate
// during walkthrough streaming is the signature of the O(N²) re-parse freeze.
// Reported every 100 calls so the on-disk log shows the explosion + its rate.
let rmCalls = 0;
let rmChars = 0;
let rmLastReport = 0;

marked.setOptions({
  breaks: true,
  gfm: true,
});

marked.use({
  hooks: {
    // Wrap every rendered table in a scroll container so wide tables don't
    // blow out narrow panels. Styled globally via `.prose-table` in app.css.
    // The `not-prose` opt-out keeps @tailwindcss/typography from layering its
    // own table defaults (margins, row borders) onto the inner `<table>`, so
    // `.prose-table` fully owns table rendering inside a `.prose` surface.
    // Safe because the custom code renderer escapes `<` to `&lt;` — real
    // `<table>` tags only appear for actually-rendered GFM tables.
    postprocess(html: string): string {
      return html
        .replace(/<table([\s>])/g, '<div class="prose-table not-prose" tabindex="0"><table$1')
        .replace(/<\/table>/g, "</table></div>");
    },
  },
  renderer: {
    code({ text, lang }) {
      if (isMermaidLang(lang)) {
        return `<div class="mermaid-diagram not-prose" data-mermaid-src="${encodeBase64(text)}"><span class="mermaid-loading">Rendering diagram...</span></div>`;
      }
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

function isMermaidLang(lang: string | undefined): boolean {
  const normalized = lang?.trim().toLowerCase();
  return normalized === "mermaid" || normalized === "mmd";
}

// UTF-8 → base64. Inverse of the decode in mermaid.svelte.ts (atob → bytes →
// TextDecoder), so multi-byte source survives the data-attribute round-trip.
function encodeBase64(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function renderMarkdown(source: string): string {
  if (debugLogEnabled()) {
    rmCalls += 1;
    rmChars += source.length;
    if (rmCalls - rmLastReport >= 100) {
      debugLog(`renderMarkdown calls=${rmCalls} totalChars=${rmChars}`);
      rmLastReport = rmCalls;
    }
  }
  // Normalize literal \n escape sequences (AI output artefact) to real newlines
  // so that marked sees actual paragraph breaks instead of two-character text.
  const normalized = source.replace(/\\n/g, "\n");
  const raw = marked.parse(normalized, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ["style", "class", "tabindex"],
  });
}

export interface MarkdownBlock {
  /** Stable-ish key for the block within this stream. */
  id: string;
  /** Raw markdown for the block, already passed through remend when active. */
  raw: string;
  /** Rendered + sanitized HTML for the block. */
  html: string;
}

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["style", "class", "tabindex"],
  });
}

const SD_SKIP_TAGS = new Set(["code", "pre", "script", "style"]);

/**
 * Per-character stagger and cap. Matches Luxe's `TextGenerativeEffect`
 * (https://animation-svelte.vercel.app/luxe/text-generate-effect):
 * `delay: index * 0.015` seconds. The cap keeps a large new tail
 * (e.g. snapshot replay on reconnect) from staggering for many seconds.
 */
const SD_CHAR_STAGGER_MS = 15;
const SD_CHAR_MAX_DELAY_MS = 900;

interface WrapCtx {
  count: number;
  prev: number;
  newCharIndex: number;
}

/**
 * Walk a parsed DOM subtree, counting plain-text characters in document
 * order. Once `count` passes `prev`, wrap each new character in a
 * `<span class="sd-char-new">` so a CSS animation can fade it in.
 * Content inside `<code>`/`<pre>` is counted but not wrapped (preserves
 * code formatting and avoids splitting inside highlighted tokens).
 */
function wrapNewWordsWalk(node: Node, ctx: WrapCtx): void {
  const children = Array.from(node.childNodes);
  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE) {
      wrapTextNode(child as Text, ctx);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (SD_SKIP_TAGS.has(tag)) {
      ctx.count += (el.textContent ?? "").length;
      continue;
    }
    wrapNewWordsWalk(el, ctx);
  }
}

function wrapTextNode(node: Text, ctx: WrapCtx): void {
  const text = node.data;
  const start = ctx.count;
  const end = start + text.length;
  ctx.count = end;
  if (end <= ctx.prev) return;

  const parent = node.parentNode;
  const doc = node.ownerDocument;
  if (!parent || !doc) return;

  const oldChars = Math.max(0, ctx.prev - start);
  const oldText = text.slice(0, oldChars);
  const newText = text.slice(oldChars);

  const frag = doc.createDocumentFragment();
  if (oldText) frag.appendChild(doc.createTextNode(oldText));

  // Match Luxe's `TextGenerativeEffect`: split per character (including
  // whitespace), wrap each in an inline-block span, stagger via
  // `animation-delay`. Iterate by Unicode code point (Array.from on a
  // string) so we don't split surrogate pairs / multi-byte emoji.
  for (const ch of Array.from(newText)) {
    const span = doc.createElement("span");
    span.className = "sd-char-new";
    const delay = Math.min(ctx.newCharIndex * SD_CHAR_STAGGER_MS, SD_CHAR_MAX_DELAY_MS);
    if (delay > 0) span.setAttribute("style", `animation-delay:${delay}ms`);
    span.textContent = ch;
    frag.appendChild(span);
    ctx.newCharIndex++;
  }
  parent.replaceChild(frag, node);
}

function wrapNewWordsInHtml(
  html: string,
  prevPlainLen: number,
): { html: string; plainLen: number } {
  if (typeof DOMParser === "undefined") return { html, plainLen: 0 };
  const doc = new DOMParser().parseFromString(`<div id="__sd_root">${html}</div>`, "text/html");
  const root = doc.getElementById("__sd_root");
  if (!root) return { html, plainLen: 0 };
  const plainLen = (root.textContent ?? "").length;
  const ctx: WrapCtx = { count: 0, prev: prevPlainLen, newCharIndex: 0 };
  wrapNewWordsWalk(root, ctx);
  return { html: root.innerHTML, plainLen };
}

/**
 * Create a stateful renderer that splits streamed markdown into top-level
 * blocks and wraps newly-arrived characters in the active block with a
 * `<span class="sd-char-new">` so they can fade in via CSS (matches Luxe's
 * `TextGenerativeEffect`).
 *
 * Stateful because the renderer tracks the previously-rendered plain-text
 * length of the active block across calls — only characters past that
 * boundary are wrapped, which prevents already-shown words from
 * re-animating each time `{@html}` replaces the inner content.
 *
 * The final block is treated as "in-progress" and run through `remend`
 * so dangling tokens (open `**`, half-typed links, unclosed code fences)
 * auto-close to keep the rendered HTML stable mid-chunk. Earlier blocks
 * are rendered plain (no per-word wrapping, no remend) — they're closed
 * by construction.
 *
 * Block identity is the lexer index: marked's lexer is deterministic on
 * the input prefix, so a finalized block stays at the same index forever
 * and a growing trailing block stays at the same index too. Keying by
 * index lets Svelte preserve the wrapper `<div>` across chunks.
 */
export function createStreamingBlockRenderer(): (source: string) => MarkdownBlock[] {
  let prevActiveBlockKey: string | null = null;
  let prevActivePlainLen = 0;
  // Memoize the last (input → output) so repeat calls with the same source
  // (which happens whenever Svelte re-evaluates a `$derived` that depends on
  // unrelated reactive state) return the cached result without re-mutating
  // `prevActivePlainLen`. Without this, the second call sees prev == current
  // and produces zero wrapped words — no animation.
  let lastInput: string | null = null;
  let lastResult: MarkdownBlock[] = [];

  return function render(source: string): MarkdownBlock[] {
    if (source === lastInput) return lastResult;
    const normalized = source.replace(/\\n/g, "\n");
    const tokens = marked.lexer(normalized);
    if (tokens.length === 0) {
      prevActiveBlockKey = null;
      prevActivePlainLen = 0;
      lastInput = source;
      lastResult = [];
      return lastResult;
    }

    const meaningful: { token: (typeof tokens)[number]; lexerIdx: number }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;
      if ((token.raw ?? "").trim().length === 0) continue;
      meaningful.push({ token, lexerIdx: i });
    }
    if (meaningful.length === 0) {
      prevActiveBlockKey = null;
      prevActivePlainLen = 0;
      lastInput = source;
      lastResult = [];
      return lastResult;
    }

    const lastIdx = meaningful.length - 1;
    const blocks: MarkdownBlock[] = [];
    for (let j = 0; j < meaningful.length; j++) {
      const entry = meaningful[j];
      if (!entry) continue;
      const { token, lexerIdx } = entry;
      const isActive = j === lastIdx;
      const rawSource = token.raw ?? "";
      const raw = isActive ? remend(rawSource) : rawSource;
      const baseHtml = marked.parse(raw, { async: false }) as string;
      const blockKey = String(lexerIdx);

      let html: string;
      if (isActive) {
        const prev = prevActiveBlockKey === blockKey ? prevActivePlainLen : 0;
        const wrapped = wrapNewWordsInHtml(baseHtml, prev);
        html = sanitize(wrapped.html);
        prevActiveBlockKey = blockKey;
        prevActivePlainLen = wrapped.plainLen;
      } else {
        html = sanitize(baseHtml);
      }

      blocks.push({ id: blockKey, raw, html });
    }
    lastInput = source;
    lastResult = blocks;
    return blocks;
  };
}
