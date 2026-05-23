/**
 * Route-change choreography.
 *
 * Two layers:
 *
 * 1. Default crossfade — any route change fades out the previous main slot
 *    and fades in the next one (subtle, ~180ms). Persistent chrome (rail,
 *    sidebar, tabs, right panel) is untouched because those live above the
 *    page slot in the layout tree.
 *
 * 2. Flip hero morphs — for specific route pairs, we capture state of a
 *    shared element (matched by `data-flip-id`) before navigation, then run
 *    `Flip.from(...)` once the new page has mounted. The persistent element
 *    "morphs" from its old position/size to the new one.
 *
 * Wiring: import `setupPageTransitions()` from +layout.svelte inside an
 * $effect. It registers SvelteKit's beforeNavigate/afterNavigate hooks and
 * returns a disposer.
 */
import { afterNavigate, beforeNavigate } from "$app/navigation";

import { Flip, gsap } from "./gsap";
import { prefersReducedMotion } from "./match-media";
import { pageEnter } from "./presets";
import { tokens } from "./tokens";

interface PendingFlip {
  state: Flip.FlipState;
  matcher: string;
}

let pending: PendingFlip | null = null;

const FLIP_RULES: Array<{
  match: (from: string, to: string) => boolean;
  selector: string;
}> = [
  {
    // PR list/home → review/[prId]
    match: (from, to) => to.startsWith("/review/") && from !== to,
    selector: "[data-flip-id^='pr-']",
  },
  {
    // /repo/[id] → /repo/[id]/recaps/[recapId]
    match: (from, to) =>
      /^\/repo\/[^/]+\/recaps\//.test(to) && /^\/repo\/[^/]+/.test(from),
    selector: "[data-flip-id^='recap-']",
  },
];

function findRule(from: string, to: string): { selector: string } | null {
  for (const rule of FLIP_RULES) {
    if (rule.match(from, to)) return { selector: rule.selector };
  }
  return null;
}

function findPageRoot(): HTMLElement | null {
  // Pages render inside <main data-page-root> declared in AppShell.
  // Fall back to <main> if the marker is absent (e.g., tests).
  return (
    (document.querySelector("[data-page-root]") as HTMLElement | null) ??
    (document.querySelector("main") as HTMLElement | null)
  );
}

/**
 * Register navigation hooks. Must be called during component initialization
 * (e.g., from within `$effect` in +layout.svelte). SvelteKit automatically
 * unregisters the listeners when the calling component is destroyed.
 */
export function setupPageTransitions(): void {
  beforeNavigate((nav) => {
    if (!nav.to || !nav.from) return;
    if (prefersReducedMotion()) return;
    const fromPath = nav.from.url.pathname;
    const toPath = nav.to.url.pathname;
    const rule = findRule(fromPath, toPath);
    if (rule) {
      const targets = document.querySelectorAll(rule.selector);
      if (targets.length > 0) {
        pending = {
          state: Flip.getState(targets, { props: "borderRadius,backgroundColor" }),
          matcher: rule.selector,
        };
      }
    }
  });

  afterNavigate(() => {
    if (prefersReducedMotion()) {
      pending = null;
      return;
    }

    // Run the Flip on the next microtask so the new page has had a chance to
    // mount its data-flip-id targets.
    queueMicrotask(() => {
      if (pending) {
        const targets = document.querySelectorAll(pending.matcher);
        if (targets.length > 0) {
          Flip.from(pending.state, {
            targets,
            duration: tokens.page,
            ease: tokens.easeOutExpo,
            absolute: true,
            scale: true,
          });
        }
        pending = null;
      } else {
        // Default crossfade-up on the page root.
        const root = findPageRoot();
        if (root) {
          // Cancel any in-flight tween on the root before starting a new one.
          gsap.killTweensOf(root);
          pageEnter(root);
        }
      }
    });
  });
}
