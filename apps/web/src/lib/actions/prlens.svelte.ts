import type { Action } from "svelte/action";

import { gsap, prefersReducedMotion, tokens } from "$lib/motion";
import { getResolvedTheme } from "$lib/stores/theme.svelte";
import { renderPrLens } from "$lib/utils/prlens.svelte";
import { applyColourAttributes } from "$lib/utils/prlens-theme";

type ResolvedTheme = "light" | "dark";

const SELECTOR = ".prlens-diagram[data-prlens-src]";

/** The element a diagram is allowed to grow across. Nearest ancestor wins. */
const BREAKOUT_HOST = "[data-prlens-breakout]";

/**
 * How far past the reading column a diagram may reach, as a multiple of that
 * column's width.
 *
 * 1.5 is half a column of overhang, which the diagram splits evenly either side
 * of the column — a quarter-column of bleed left and right. Past that a diagram
 * stops reading as an illustration of the text it sits in and starts reading as
 * its own spread. Expressed as a ratio rather than in pixels so the cap holds in
 * the stacked layout and in any other breakout host, instead of tracking one
 * grid's gutters, which grow without bound as the window widens.
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
 * The overhang is split evenly either side rather than hung entirely off the
 * right. A diagram is the one block on the page whose width is decided by its
 * own content instead of by the column, so its edges land wherever its lane
 * count puts them; anchored left, the right edge floats free of every other
 * edge on the page and the block reads as having slipped sideways. Centred, the
 * two overhangs are equal and the diagram reads as deliberately wider than the
 * text, which is what it is. Whatever one side cannot take — a narrow gutter, a
 * stacked layout — the other absorbs, so the breakout degrades to the old
 * left-anchored growth rather than to no growth at all.
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

  // Measure the diagram where it naturally sits, not where a previous pass put
  // it — the offset included, or the next pass measures its own displacement.
  container.style.removeProperty("width");
  container.style.removeProperty("max-width");
  container.style.removeProperty("margin-left");

  const hostStyle = getComputedStyle(host);
  const hostBox = host.getBoundingClientRect();
  const hostLeft = hostBox.left + Number.parseFloat(hostStyle.paddingLeft);
  const hostRight = hostBox.right - Number.parseFloat(hostStyle.paddingRight);

  const box = container.getBoundingClientRect();
  if (box.width <= 0) return;

  // Room past each edge of the column, floored at 0: a host narrower than the
  // column on one side offers nothing there, it does not owe the other side.
  const roomLeft = Math.max(box.left - hostLeft, 0);
  const roomRight = Math.max(hostRight - box.right, 0);
  if (!Number.isFinite(roomLeft) || !Number.isFinite(roomRight)) return;
  if (roomLeft + roomRight <= 0) return;

  // The SVG scales to the container's content box, so the box has to carry the
  // diagram's natural width plus whatever the frame costs.
  const style = getComputedStyle(container);
  const frame =
    Number.parseFloat(style.paddingLeft) +
    Number.parseFloat(style.paddingRight) +
    Number.parseFloat(style.borderLeftWidth) +
    Number.parseFloat(style.borderRightWidth);

  // Never past natural size — an SVG blown up beyond it just looks oversized —
  // never past the host, and never past the cap.
  const width = Math.min(
    box.width + roomLeft + roomRight,
    box.width * MAX_BREAKOUT_RATIO,
    naturalWidth + frame,
  );
  if (width <= box.width) return;

  // Half the overhang to the left, unless the left gutter is too shallow to
  // take it (clamped down) or the right one is too shallow to take its own
  // share (pushed up, so the left makes up the difference).
  const overhang = width - box.width;
  const shift = Math.min(Math.max(overhang / 2, overhang - roomRight), roomLeft);

  container.style.width = `${Math.round(width)}px`;
  container.style.maxWidth = "none";
  if (shift > 0) container.style.marginLeft = `${-Math.round(shift)}px`;
}

function decodeSource(encoded: string): string | null {
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Re-indent the body so a rejected diagram is still readable as the fallback. */
function formatSource(source: string): string {
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return source;
  }
}

/**
 * Stand a failure in for the diagram: what went wrong, and the source folded
 * away behind a disclosure.
 *
 * The source stays reachable — it is the only way to see *which* diagram broke
 * and to correct it from the chat — but it does not stay open. A graph document
 * runs to hundreds of lines, and dumped inline it evicts the prose around it
 * from the screen entirely, turning one unrenderable diagram into a chapter the
 * reader cannot read.
 */
function showFallback(container: HTMLElement, source: string, error: string): void {
  const note = document.createElement("div");
  note.className = "prlens-error";
  note.textContent = error || "Diagram failed to render.";

  // A source that could not even be decoded has nothing to disclose.
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

export const prlensDiagrams: Action<HTMLElement, ResolvedTheme | undefined> = (node, theme) => {
  let currentTheme: ResolvedTheme = theme ?? getResolvedTheme();
  let destroyed = false;
  let scheduled = false;
  let rendering = false;
  let rerunAfterRender = false;

  // Natural widths of the diagrams rendered under this node, so a host resize
  // can re-measure their breakout without re-rendering the SVG.
  const naturalWidths = new Map<HTMLElement, number>();
  // Breakout hosts currently under observation. Tracked so they can be dropped
  // symmetrically with `naturalWidths`; observing is per-diagram, so without
  // this the observer accumulates hosts whose diagrams are long gone.
  const observedHosts = new Set<HTMLElement>();
  const resizeObserver = new ResizeObserver(() => {
    for (const [diagram, naturalWidth] of naturalWidths) {
      if (node.contains(diagram)) applyBreakout(diagram, naturalWidth);
      else naturalWidths.delete(diagram);
    }
    // Drop a host once no diagram we still track resolves to it — a host is an
    // *ancestor* of `node`, so it can never be tested with `node.contains(...)`:
    // that unobserved every host on the first callback, and the diagrams then
    // kept whatever width the layout had at that instant. Opening a pane after
    // that left them sized for a column that no longer existed, hanging off the
    // edge of the reading area.
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

  const schedule = (): void => {
    if (destroyed) return;
    if (rendering) {
      rerunAfterRender = true;
      return;
    }
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void renderAll();
    });
  };

  const renderAll = async (): Promise<void> => {
    rendering = true;
    const themeForRun = currentTheme;
    // Read once per run rather than per diagram, so one batch is internally
    // consistent. A change between runs changes `markerForRun`, which is what
    // makes already-rendered diagrams eligible again.
    const animateForRun = !prefersReducedMotion();
    // Theme *and* motion change the emitted markup, so the "already rendered"
    // marker has to carry both — keying it on theme alone left a diagram
    // animating after the user turned reduced motion on.
    const markerForRun = `${themeForRun}:${animateForRun ? "motion" : "still"}`;
    try {
      const containers = Array.from(node.querySelectorAll<HTMLElement>(SELECTOR));
      const pending = containers.filter(
        (container) => container.dataset.prlensRender !== markerForRun,
      );
      if (pending.length === 0) return;

      for (const container of pending) {
        // A detached container drops out of the batch; only teardown aborts it.
        // `return`ing on either abandoned every later diagram in `pending`.
        if (destroyed) return;
        if (!node.contains(container)) continue;
        const encoded = container.dataset.prlensSrc;
        if (!encoded) continue;

        const source = decodeSource(encoded);
        if (source === null) {
          showFallback(container, "", "Diagram source could not be decoded.");
          container.dataset.prlensRender = markerForRun;
          continue;
        }

        container.innerHTML = '<span class="prlens-loading">Rendering diagram...</span>';

        const result = await renderPrLens(source, themeForRun, animateForRun);
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
        container.dataset.prlensRender = markerForRun;
      }
    } finally {
      rendering = false;
      if (rerunAfterRender) {
        rerunAfterRender = false;
        schedule();
      }
    }
  };

  const observer = new MutationObserver(schedule);
  observer.observe(node, { childList: true, subtree: true });
  schedule();

  return {
    update(nextTheme) {
      currentTheme = nextTheme ?? getResolvedTheme();
      schedule();
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
      resizeObserver.disconnect();
      observedHosts.clear();
      naturalWidths.clear();
    },
  };
};
