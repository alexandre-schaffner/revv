import { isPrLensFenceLang } from "@revv/shared";
import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";
import remend from "remend";
import { highlightCode, isHighlighterReady } from "./highlighter.svelte";
import { diagramPlaceholder } from "./prlens-fence";

/**
 * Who wrote the markdown. `agent`: Revv's own agents; their HTML keeps its
 * `class`/`style` and `prlens` fences become diagrams. `external`: anyone
 * else (GitHub PR bodies, comments, reviews, CI summaries, the user's own
 * text); its raw HTML may not restyle the app.
 */
export type MarkdownTrust = "agent" | "external";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function createParser(trust: MarkdownTrust): Marked {
  return new Marked({
    breaks: true,
    gfm: true,
    hooks: {
      // Wrap every rendered table in a scroll container so wide tables don't
      // blow out narrow panels. Styled globally via `.prose-table` in
      // prose.css. `not-prose` keeps @tailwindcss/typography from layering its
      // own table defaults onto the inner `<table>`. Safe because the code
      // renderer escapes `<`: real `<table>` tags only come from GFM tables.
      postprocess(html: string): string {
        return html
          .replace(/<table([\s>])/g, '<div class="prose-table not-prose" tabindex="0"><table$1')
          .replace(/<\/table>/g, "</table></div>");
      },
    },
    renderer: {
      code({ text, lang }: Tokens.Code): string {
        if (trust === "agent" && isPrLensFenceLang(lang)) return diagramPlaceholder(text);
        if (lang) {
          const highlighted = highlightCode(text, lang);
          if (highlighted) return highlighted;
        }
        const langClass = lang ? ` class="language-${lang}"` : "";
        return `<pre><code${langClass}>${escapeHtml(text)}</code></pre>`;
      },
    },
  });
}

const parsers: Record<MarkdownTrust, Marked> = {
  agent: createParser("agent"),
  external: createParser("external"),
};

/**
 * Agents sometimes emit literal `\n` escapes for newlines. In anyone else's
 * text a literal `\n` is what the author typed.
 */
function normalize(source: string, trust: MarkdownTrust): string {
  return trust === "agent" ? source.replace(/\\n/g, "\n") : source;
}

/** Declarations Shiki's highlighting writes: colors, nothing that can move or cover. */
const SAFE_STYLE_PROPERTY = /^(?:color|background-color|--shiki[\w-]*)$/;
/** The renderer's and Shiki's own class names; no app utility class gets through. */
const SAFE_CLASS = /^(?:shiki[\w-]*|line|language-[\w+#.-]+|prose-table|not-prose)$/;

/**
 * What an attribute of external HTML keeps, or null to drop it. No external
 * HTML may restyle the app: `style` survives only when every declaration is
 * a color, and `class` keeps only the renderer's own names, so no
 * fixed-position overlay can pass for an app dialog.
 */
export function externalAttribute(name: string, value: string): string | null {
  if (name === "style") {
    const colorsOnly = value.split(";").every((declaration) => {
      const property = declaration.split(":")[0]?.trim().toLowerCase() ?? "";
      return property === "" || SAFE_STYLE_PROPERTY.test(property);
    });
    return colorsOnly ? value : null;
  }
  if (name === "class") {
    const kept = value.split(/\s+/).filter((className) => SAFE_CLASS.test(className));
    return kept.length > 0 ? kept.join(" ") : null;
  }
  return value;
}

let externalPurify: ReturnType<typeof DOMPurify> | null = null;

function externalSanitizer(): ReturnType<typeof DOMPurify> {
  if (externalPurify) return externalPurify;
  const purify = DOMPurify();
  purify.addHook("uponSanitizeAttribute", (_node, data) => {
    const kept = externalAttribute(data.attrName, data.attrValue);
    if (kept === null) data.keepAttr = false;
    else data.attrValue = kept;
  });
  externalPurify = purify;
  return purify;
}

function sanitize(html: string, trust: MarkdownTrust): string {
  return trust === "agent"
    ? DOMPurify.sanitize(html, { ADD_ATTR: ["style", "class", "tabindex"] })
    : externalSanitizer().sanitize(html, { ADD_ATTR: ["style", "tabindex"] });
}

function render(normalized: string, trust: MarkdownTrust): string {
  return sanitize(parsers[trust].parse(normalized, { async: false }), trust);
}

// Rendered HTML per top-level block, keyed on trust and the block's source.
// Insertion-ordered, so the oldest entry is evicted first once full.
const blockHtmlCache = new Map<string, string>();
const BLOCK_CACHE_LIMIT = 2000;

function renderBlock(raw: string, trust: MarkdownTrust): string {
  const key = `${trust}\u0000${raw}`;
  const cached = blockHtmlCache.get(key);
  if (cached !== undefined) return cached;
  const html = render(raw, trust);
  // A block rendered before Shiki loaded holds plain `<pre>`; don't pin it.
  if (isHighlighterReady()) {
    if (blockHtmlCache.size >= BLOCK_CACHE_LIMIT) {
      const oldest = blockHtmlCache.keys().next().value;
      if (oldest !== undefined) blockHtmlCache.delete(oldest);
    }
    blockHtmlCache.set(key, html);
  }
  return html;
}

/**
 * Markdown rendered and sanitized, split into top-level blocks that each
 * render on their own. A streamed message only ever grows its last block, so
 * the earlier ones come back from the cache unchanged and a `{@html}` per
 * block leaves their DOM alone: a chunk costs one block's parse, highlight
 * and sanitize, not the whole message's.
 *
 * Two constructs reach across blocks and only survive as one parse: a raw
 * HTML block opening an element a later block closes (`<details>` around
 * markdown), and a `[ref]: url` definition serving another block's link. A
 * source holding either renders as a single block.
 */
export function renderMarkdownBlocks(source: string, trust: MarkdownTrust): string[] {
  const normalized = normalize(source, trust);
  const tokens = parsers[trust].lexer(normalized);
  const crossBlock =
    Object.keys(tokens.links).length > 0 || tokens.some((token) => token.type === "html");
  if (crossBlock) return [render(normalized, trust)];
  return tokens
    .filter((token) => token.type !== "space")
    .map((token) => renderBlock(token.raw, trust));
}

/** The top-level blocks of agent markdown, as source. */
export function splitAgentMarkdown(source: string): string[] {
  return parsers.agent
    .lexer(normalize(source, "agent"))
    .map((token) => token.raw)
    .filter((raw) => raw.trim().length > 0);
}

const FADE_SKIP_TAGS = new Set(["code", "pre", "script", "style"]);

/**
 * Per-character stagger and cap. Matches Luxe's `TextGenerativeEffect`
 * (https://animation-svelte.vercel.app/luxe/text-generate-effect):
 * `delay: index * 0.015` seconds. The cap keeps a large new tail
 * (e.g. snapshot replay on reconnect) from staggering for many seconds.
 */
const FADE_CHAR_STAGGER_MS = 15;
const FADE_CHAR_MAX_DELAY_MS = 900;

interface FadeWalk {
  count: number;
  prev: number;
  newCharIndex: number;
}

/**
 * Count plain-text characters in document order and wrap each one past
 * `prev` in a `.sd-char-new` span. Text inside `<code>`/`<pre>` is counted
 * but never wrapped, so highlighted tokens aren't split.
 */
function wrapNewChars(node: Node, walk: FadeWalk): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      wrapTextNode(child as Text, walk);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    if (FADE_SKIP_TAGS.has(el.tagName.toLowerCase())) {
      walk.count += (el.textContent ?? "").length;
      continue;
    }
    wrapNewChars(el, walk);
  }
}

function wrapTextNode(node: Text, walk: FadeWalk): void {
  const text = node.data;
  const start = walk.count;
  walk.count = start + text.length;
  if (walk.count <= walk.prev) return;

  const parent = node.parentNode;
  const doc = node.ownerDocument;
  if (!parent || !doc) return;

  const oldChars = Math.max(0, walk.prev - start);
  const frag = doc.createDocumentFragment();
  if (oldChars > 0) frag.appendChild(doc.createTextNode(text.slice(0, oldChars)));

  // By code point, so surrogate pairs stay whole.
  for (const ch of Array.from(text.slice(oldChars))) {
    const span = doc.createElement("span");
    span.className = "sd-char-new";
    const delay = Math.min(walk.newCharIndex * FADE_CHAR_STAGGER_MS, FADE_CHAR_MAX_DELAY_MS);
    if (delay > 0) span.setAttribute("style", `animation-delay:${delay}ms`);
    span.textContent = ch;
    frag.appendChild(span);
    walk.newCharIndex++;
  }
  parent.replaceChild(frag, node);
}

/**
 * A renderer for one growing piece of agent markdown that wraps the
 * characters added since its previous call in `.sd-char-new` spans, which
 * app.css fades in. Dangling syntax (an open `**`, a half-typed link) is
 * closed with `remend` so the HTML holds still mid-chunk.
 */
export function createFadeRenderer(): (source: string) => string {
  let shownChars = 0;
  let lastKey: string | null = null;
  let lastHtml = "";

  return (source) => {
    // Unrelated reactive reads re-run the caller with the same source; a
    // second pass would find nothing new and drop the fade.
    const key = `${isHighlighterReady()}\u0000${source}`;
    if (key === lastKey) return lastHtml;
    const html = parsers.agent.parse(remend(normalize(source, "agent")), { async: false });
    const doc = new DOMParser().parseFromString(`<div id="fade-root">${html}</div>`, "text/html");
    const root = doc.getElementById("fade-root");
    let wrapped = html;
    if (root) {
      const total = (root.textContent ?? "").length;
      wrapNewChars(root, { count: 0, prev: shownChars, newCharIndex: 0 });
      shownChars = total;
      wrapped = root.innerHTML;
    }
    lastKey = key;
    lastHtml = sanitize(wrapped, "agent");
    return lastHtml;
  };
}
