import type { Palette } from "@coldtea/pr-lens-renderer";

/**
 * PR Lens bakes GitHub's palette into every SVG as literal colours — it has to,
 * because its diagrams are normally served to a GitHub comment through an image
 * proxy, where nothing outside the file exists. We render inline into our own
 * DOM instead, so the page *is* available and the diagram can wear Revv's
 * palette. `render()` takes no palette, so we translate its output afterwards.
 *
 * The literals are read back from `paletteFor(theme)` rather than restated here,
 * so a palette change in the package cannot silently stop matching.
 */
const TOKEN_BY_ROLE: Record<keyof Palette, string | null> = {
  background: "var(--color-bg-primary)",
  dot: "var(--color-border)",
  lane: "var(--color-bg-secondary)",
  card: "var(--color-bg-elevated)",
  cardBorder: "var(--color-border)",
  foreground: "var(--color-text-primary)",
  // `muted` carries card subtitles and lane headers — real content, just
  // de-emphasised — so it takes secondary rather than muted, whose light value
  // (#9a958c) is far paler than the #59636e it replaces and washes them out.
  // `edge` is genuine background structure and does match muted closely.
  muted: "var(--color-text-secondary)",
  edge: "var(--color-text-muted)",
  chip: "var(--color-bg-tertiary)",
  pill: "var(--color-bg-primary)",
  pillBorder: "var(--color-border-subtle)",
  lifeline: "var(--color-border)",

  // The delta tints are mixed from the three semantic colours rather than
  // mapped to fixed surfaces: we have designed diff surfaces for added and
  // removed but nothing for modified, and a diagram whose three deltas came
  // from two different sources would not read as one system.
  added: "var(--color-success)",
  addedFill: "color-mix(in srgb, var(--color-success) 15%, transparent)",
  addedBorder: "color-mix(in srgb, var(--color-success) 45%, transparent)",
  modified: "var(--color-warning)",
  modifiedFill: "color-mix(in srgb, var(--color-warning) 15%, transparent)",
  modifiedBorder: "color-mix(in srgb, var(--color-warning) 45%, transparent)",
  removed: "var(--color-danger)",
  removedFill: "color-mix(in srgb, var(--color-danger) 15%, transparent)",
  removedBorder: "color-mix(in srgb, var(--color-danger) 45%, transparent)",

  neutralFill: "var(--color-bg-tertiary)",

  // Left alone: this one is a drop-shadow colour rather than a surface, and our
  // nearest token is a full box-shadow, which is not a colour.
  shadow: null,
};

/** Colour attributes PR Lens writes directly onto elements. */
const COLOUR_ATTRIBUTES = ["fill", "stroke", "stop-color"] as const;

export type ColourMap = ReadonlyMap<string, string>;

/**
 * Literal colour → the token that replaces it.
 *
 * Several roles legitimately share one literal — in the light palette the page,
 * a card and a label pill are all `#ffffff` — and a literal can only be
 * translated one way. First role wins, which is safe by construction: roles that
 * shared a colour were meant to look identical, and they still will.
 */
export function buildColourMap(palette: Palette): ColourMap {
  const map = new Map<string, string>();
  for (const [role, token] of Object.entries(TOKEN_BY_ROLE)) {
    if (token === null) continue;
    const literal = palette[role as keyof Palette];
    if (!map.has(literal)) map.set(literal, token);
  }
  return map;
}

/** Ancestor every rule in the SVG's own stylesheet is confined to. */
const SCOPE = ".prlens-diagram";

/**
 * Confine every selector in the renderer's stylesheet to {@link SCOPE}.
 *
 * A `<style>` element inside *inline* SVG in an HTML document is **not** scoped
 * to that SVG — it joins the document's stylesheet set like any other. The
 * renderer writes for a standalone `.svg` served through GitHub's image proxy,
 * where that distinction does not exist, so its selectors are bare: `text{…}`,
 * `.card{…}`, `.chip{…}`, `.hero{…}`, `.faded{opacity:.45}`,
 * `.strike{text-decoration:line-through}`. Injected as-is, the first diagram to
 * render restyles every `<text>` in every other inline SVG on the page and puts
 * five generic class names into the global cascade — and this app already uses
 * `.hero`, `.card` and `.chip` elsewhere, where they survive only because
 * Svelte's scoping hash happens to out-specify the leak.
 *
 * At-rules are left alone: the renderer emits none today, and blindly prefixing
 * an `@media` prelude would corrupt it.
 */
function scopeSelectors(css: string): string {
  return css.replace(/([^{}]+)\{([^{}]*)\}/g, (rule, prelude: string, body: string) => {
    const selector = prelude.trim();
    if (selector.startsWith("@")) return rule;
    const scoped = selector
      .split(",")
      .map((part) => `${SCOPE} ${part.trim()}`)
      .join(",");
    return `${scoped}{${body}}`;
  });
}

/**
 * Retint the SVG's `<style>` block and confine it to the diagram.
 *
 * Colour rewriting is scoped to that block on purpose. Custom properties
 * resolve in a stylesheet but *not* in an SVG presentation attribute, so
 * rewriting `fill="#1c2128"` in the markup would produce an attribute the
 * browser silently drops; {@link applyColourAttributes} moves those into inline
 * styles instead, where `var()` does work.
 */
export function themeStyleBlock(svg: string, colours: ColourMap): string {
  return svg.replace(/<style>([\s\S]*?)<\/style>/, (_match, css: string) => {
    let themed = css;
    // Longest first: no literal may be rewritten inside another's replacement.
    for (const literal of [...colours.keys()].sort((a, b) => b.length - a.length)) {
      themed = themed.split(literal).join(colours.get(literal) ?? literal);
    }
    return `<style>${scopeSelectors(themed)}</style>`;
  });
}

/**
 * Move colour-bearing presentation attributes onto the element's inline style,
 * where a custom property actually resolves. Anything we have no token for —
 * `url(#dots)`, `none`, `currentColor` — is left exactly as it was.
 */
export function applyColourAttributes(root: ParentNode, colours: ColourMap): void {
  for (const element of root.querySelectorAll<SVGElement>("[fill], [stroke], [stop-color]")) {
    for (const attribute of COLOUR_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      const token = colours.get(value);
      if (token === undefined) continue;
      element.style.setProperty(attribute, token);
      element.removeAttribute(attribute);
    }
  }
}
