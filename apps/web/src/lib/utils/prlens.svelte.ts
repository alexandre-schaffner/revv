import type { Lens } from "@coldtea/pr-lens-schema";
import { toGraphDocInput } from "@revv/shared";

import { buildColourMap, type ColourMap, themeStyleBlock } from "./prlens-theme";

type AppTheme = "light" | "dark";
type Rendered = { svg: string; width: number; colours: ColourMap };
type RenderResult = Rendered | { error: string };

type PrLensModules = {
  schema: typeof import("@coldtea/pr-lens-schema");
  renderer: typeof import("@coldtea/pr-lens-renderer");
};

let modules: PrLensModules | null = null;
let loadPromise: Promise<PrLensModules> | null = null;

/**
 * Rendered SVGs, keyed on everything that changes the output.
 *
 * Bounded, and evicted oldest-first. This is a desktop app whose window is
 * never reloaded, so an unbounded module-level cache retains every diagram
 * rendered in the session — and each entry holds a full SVG string. The cap is
 * generous next to how many diagrams a walkthrough actually contains; it exists
 * to make the ceiling finite, not to be tight.
 */
const SVG_CACHE_LIMIT = 64;
const svgCache = new Map<string, Rendered>();

function cacheRendered(key: string, rendered: Rendered): void {
  if (svgCache.size >= SVG_CACHE_LIMIT) {
    // Map iterates in insertion order, so the first key is the oldest.
    const oldest = svgCache.keys().next();
    if (!oldest.done) svgCache.delete(oldest.value);
  }
  svgCache.set(key, rendered);
}

/**
 * Load the renderer's chunks once, sharing one in-flight import across
 * concurrent diagrams.
 *
 * A *rejected* load is deliberately not memoised. Chunk loads fail for reasons
 * that pass — offline, or a stale `index.html` pointing at a hash the in-app
 * updater has already replaced — and a cached rejection would mean no diagram
 * could ever render again for the life of the (never-reloaded) Tauri window.
 */
async function loadPrLens(): Promise<PrLensModules> {
  if (modules) return modules;
  loadPromise ??= Promise.all([
    import("@coldtea/pr-lens-schema"),
    import("@coldtea/pr-lens-renderer"),
  ])
    .then(([schema, renderer]) => ({ schema, renderer }))
    .catch((error: unknown) => {
      loadPromise = null;
      throw error;
    });
  modules = await loadPromise;
  return modules;
}

/**
 * Strip the renderer's looping dot animations.
 *
 * The renderer emits SMIL (`<animateMotion repeatCount="indefinite">`) for edge
 * pulses and data-flow messages, and `RenderOptions` offers no way to turn it
 * off. SMIL is not CSS animation, so neither `animation: none` nor the
 * defensive `prefers-reduced-motion` block in `app.css` touches it — leaving a
 * reduced-motion user with perpetually moving dots and the compositor awake for
 * as long as the walkthrough is open.
 *
 * The whole animated `<circle>` goes, not just its `<animate*>` children:
 * removing only the animation would strand a data-flow dot at `opacity="0"`
 * (invisible, fine) but a pulse dot parked at the start of its path (a stray
 * mark, not fine). The dots are decorative — the edges and lifelines they
 * travel carry the structure — so dropping them costs no information.
 *
 * Only `wrap()`ped circles have children; every static circle is self-closing,
 * which is what the `[^/]>` guard keeps this from swallowing.
 */
function stripAnimation(svg: string): string {
  return svg.replace(/<circle\b[^>]*[^/]>[\s\S]*?<\/circle>/g, (element) =>
    element.includes("<animate") ? "" : element,
  );
}

/** Trim a failure down to something that fits in a diagram-sized fallback box. */
function truncate(message: string, limit = 400): string {
  return message.length <= limit ? message : `${message.slice(0, limit - 1)}…`;
}

/**
 * Render one `prlens` fence to a self-contained SVG.
 *
 * The source is the JSON body of a graph document. Rendering is deterministic
 * for a given body, theme and motion preference, so results are cached on all
 * three — `animate` belongs in the key because it changes the emitted markup.
 *
 * Never rejects: every failure — bad JSON, a rejected document, a chunk that
 * would not load, a renderer throw — comes back as `{ error }` for the caller
 * to show in its fallback box. The caller re-renders from a `MutationObserver`,
 * so a thrown rejection there becomes an unhandled rejection *per DOM change*.
 */
export async function renderPrLens(
  source: string,
  theme: AppTheme,
  animate: boolean,
): Promise<RenderResult> {
  const cacheKey = `${theme}\u0000${animate ? "motion" : "still"}\u0000${source}`;
  const cached = svgCache.get(cacheKey);
  if (cached) return cached;

  let body: unknown;
  try {
    body = JSON.parse(source);
  } catch (error) {
    return {
      error: `Diagram is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`,
    };
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Diagram must be a JSON object." };
  }

  try {
    const { schema, renderer } = await loadPrLens();

    const parsed = schema.safeParseGraphDoc(
      toGraphDocInput(body as Record<string, unknown>, schema.SCHEMA_VERSION),
    );
    if (!parsed.ok) {
      return { error: truncate(`Diagram rejected: ${schema.formatIssues(parsed.error.issues)}`) };
    }

    // `lenses` is non-empty by contract; the guard is for `noUncheckedIndexedAccess`.
    const lens: Lens | undefined = parsed.value.lenses[0];
    if (lens === undefined) return { error: "Diagram declares no lens." };

    const { svg, width, animated } = renderer.render(parsed.value, { lens, theme });
    const colours = buildColourMap(renderer.paletteFor(theme));
    // `animated` is the renderer's own answer for whether it emitted any SMIL,
    // so a still diagram skips the strip entirely.
    const themed = themeStyleBlock(animated && !animate ? stripAnimation(svg) : svg, colours);
    const rendered = { svg: themed, width, colours };
    cacheRendered(cacheKey, rendered);
    return rendered;
  } catch (error) {
    return {
      error: truncate(error instanceof Error ? error.message : "Diagram failed to render."),
    };
  }
}
