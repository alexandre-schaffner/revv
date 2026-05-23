/**
 * Route-change choreography.
 *
 * This module only handles the Flip hero morphs. The default crossfade
 * runs in AppShell.svelte via a `{#key page.url.pathname}` wrapper +
 * `transition:gsapFade`, which lets only the routed content fade without
 * touching the persistent chrome.
 *
 * Flip layer: for specific route pairs, we capture state of a shared
 * element (matched by `data-flip-id`) before navigation, then run
 * `Flip.from(...)` once the new page has mounted. The persistent element
 * "morphs" from its old position/size to the new one.
 *
 * Wiring: import `setupPageTransitions()` from +layout.svelte inside an
 * $effect. SvelteKit unregisters the listeners when the layout is
 * destroyed.
 */
import { afterNavigate, beforeNavigate } from "$app/navigation";

import { Flip } from "./gsap";
import { prefersReducedMotion } from "./match-media";
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
    // mount its data-flip-id targets. The default crossfade is NOT handled
    // here — the keyed {#key page.url.pathname} wrapper in AppShell.svelte
    // owns it via a Svelte transition, so the persistent main-content chrome
    // never flickers between routes.
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
      }
    });
  });
}
