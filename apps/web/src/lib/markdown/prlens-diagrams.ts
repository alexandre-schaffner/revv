import { gsap, prefersReducedMotion, tokens } from "$lib/motion";
import type { ResolvedTheme } from "$lib/stores/theme.svelte";
import { decorationAction } from "./decorate";
import { renderPrLens } from "./prlens";
import { DIAGRAM_SELECTOR, diagramSource } from "./prlens-fence";
import { applyColourAttributes } from "./prlens-theme";

const BREAKOUT_HOST = "[data-prlens-breakout]";

/**
 * How far past the reading column a diagram may reach, as a multiple of that
 * column's width.
 *
 * 1.5 is half a column of overhang, split evenly either side; past that a
 * diagram reads as its own spread rather than an illustration of the text.
 * A ratio, not pixels, so the cap holds in the stacked layout and any other
 * breakout host instead of tracking one grid's gutters.
 */
const MAX_BREAKOUT_RATIO = 1.5;

/**
 * Grow a diagram out of its reading column, into the room its host has going
 * spare, centred on the column it came from.
 *
 * The walkthrough lays content out on a six-track grid whose gutters are sized
 * by `min()`/`max()` against the viewport, so on a wide window the 820px text
 * column sits in ~2400px of grid with most of it empty. A diagram is the one
 * thing that would rather be wide than well-measured — its type is baked into
 * the SVG at a fixed size, so width it cannot get is paid for by scaling the
 * whole drawing, lettering included, down. Prose keeps its measure; the diagram
 * takes the rest.
 *
 * Overhang splits evenly either side rather than hanging off the right: a
 * diagram's width comes from its own content, so anchored left it reads as
 * slipped sideways, while centred it reads as deliberately wider. Whatever
 * one side can't take, the other absorbs.
 *
 * The room it may take is bounded twice over — by the host, and by
 * `MAX_BREAKOUT_RATIO` — because a genuinely wide diagram would otherwise take
 * every pixel the grid has going spare and dominate the page it is supposed to
 * illustrate. Past the cap it goes back to scaling down, which is the cost the
 * breakout exists to defer, not to abolish.
 *
 * Measured rather than expressed in CSS because the track widths are computed
 * from viewport percentages that resolve against the grid, not against the
 * column the diagram is nested three levels inside. Hosts opt in with
 * `data-prlens-breakout`, and a block that has an annotation beside it carries
 * the attribute itself, so nearest-ancestor pins it to its own column instead
 * of letting it grow across the rail.
 */
function applyBreakout(container: HTMLElement, naturalWidth: number): void {
  const host = container.closest<HTMLElement>(BREAKOUT_HOST);
  if (host === null || host === container) return;

  container.style.removeProperty("width");
  container.style.removeProperty("max-width");
  container.style.removeProperty("margin-left");

  const hostStyle = getComputedStyle(host);
  const hostBox = host.getBoundingClientRect();
  const hostLeft = hostBox.left + Number.parseFloat(hostStyle.paddingLeft);
  const hostRight = hostBox.right - Number.parseFloat(hostStyle.paddingRight);

  const box = container.getBoundingClientRect();
  if (box.width <= 0) return;

  const roomLeft = Math.max(box.left - hostLeft, 0);
  const roomRight = Math.max(hostRight - box.right, 0);
  if (!Number.isFinite(roomLeft) || !Number.isFinite(roomRight)) return;
  if (roomLeft + roomRight <= 0) return;

  // The SVG scales to the container's content box, not its border box.
  const style = getComputedStyle(container);
  const frame =
    Number.parseFloat(style.paddingLeft) +
    Number.parseFloat(style.paddingRight) +
    Number.parseFloat(style.borderLeftWidth) +
    Number.parseFloat(style.borderRightWidth);

  const width = Math.min(
    box.width + roomLeft + roomRight,
    box.width * MAX_BREAKOUT_RATIO,
    naturalWidth + frame,
  );
  if (width <= box.width) return;

  const overhang = width - box.width;
  const shift = Math.min(Math.max(overhang / 2, overhang - roomRight), roomLeft);

  container.style.width = `${Math.round(width)}px`;
  container.style.maxWidth = "none";
  if (shift > 0) container.style.marginLeft = `${-Math.round(shift)}px`;
}

function formatSource(source: string): string {
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return source;
  }
}

/**
 * The source stays reachable — it is the only way to see *which* diagram broke
 * and to correct it from the chat — but folded: a graph document runs to
 * hundreds of lines, and dumped inline it pushes the surrounding prose off
 * screen.
 */
function showFallback(container: HTMLElement, source: string, error: string): void {
  const note = document.createElement("div");
  note.className = "prlens-error";
  note.textContent = error || "Diagram failed to render.";

  if (source.trim().length === 0) {
    container.replaceChildren(note);
    return;
  }

  const details = document.createElement("details");
  details.className = "prlens-fallback";
  const summary = document.createElement("summary");
  summary.textContent = "Diagram source";
  const pre = document.createElement("pre");
  pre.className = "prlens-fallback-source";
  const code = document.createElement("code");
  code.textContent = formatSource(source);
  pre.appendChild(code);
  details.append(summary, pre);

  container.replaceChildren(note, details);
}

function reveal(container: HTMLElement): void {
  if (prefersReducedMotion()) return;
  gsap.fromTo(
    container,
    { autoAlpha: 0 },
    { autoAlpha: 1, duration: tokens.quick, ease: tokens.easeOutExpo },
  );
}

export const prlensDiagrams = decorationAction<ResolvedTheme>((node) => {
  let destroyed = false;

  const naturalWidths = new Map<HTMLElement, number>();
  const observedHosts = new Set<HTMLElement>();
  const resizeObserver = new ResizeObserver(() => {
    for (const [diagram, naturalWidth] of naturalWidths) {
      if (node.contains(diagram)) applyBreakout(diagram, naturalWidth);
      else naturalWidths.delete(diagram);
    }
    const live = new Set<HTMLElement>();
    for (const diagram of naturalWidths.keys()) {
      const host = diagram.closest<HTMLElement>(BREAKOUT_HOST);
      if (host !== null) live.add(host);
    }
    for (const host of observedHosts) {
      if (live.has(host)) continue;
      resizeObserver.unobserve(host);
      observedHosts.delete(host);
    }
  });

  const observeHost = (container: HTMLElement): void => {
    const host = container.closest<HTMLElement>(BREAKOUT_HOST);
    if (host === null || host === container || observedHosts.has(host)) return;
    resizeObserver.observe(host);
    observedHosts.add(host);
  };

  const apply = async (theme: ResolvedTheme): Promise<void> => {
    const animate = !prefersReducedMotion();
    const marker = `${theme}:${animate ? "motion" : "still"}`;
    const pending = Array.from(node.querySelectorAll<HTMLElement>(DIAGRAM_SELECTOR)).filter(
      (container) => container.dataset.prlensRender !== marker,
    );

    for (const container of pending) {
      if (destroyed) return;
      if (!node.contains(container)) continue;

      const source = diagramSource(container);
      if (source === null) {
        showFallback(container, "", "Diagram source could not be decoded.");
        container.dataset.prlensRender = marker;
        continue;
      }

      container.innerHTML = '<span class="prlens-loading">Rendering diagram...</span>';

      const result = await renderPrLens(source, theme, animate);
      if (destroyed) return;
      if (!node.contains(container)) continue;

      if ("svg" in result) {
        container.innerHTML = result.svg;
        applyColourAttributes(container, result.colours);
        naturalWidths.set(container, result.width);
        observeHost(container);
        applyBreakout(container, result.width);
        reveal(container);
      } else {
        naturalWidths.delete(container);
        showFallback(container, source, result.error);
      }
      container.dataset.prlensRender = marker;
    }
  };

  return {
    apply,
    destroy() {
      destroyed = true;
      resizeObserver.disconnect();
      observedHosts.clear();
      naturalWidths.clear();
    },
  };
});
