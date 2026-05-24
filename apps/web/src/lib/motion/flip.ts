/**
 * GSAP Flip helper.
 *
 * Flip is the right tool when a sibling re-renders to a new width and the
 * neighbours need to slide to their new positions instead of jumping. Today
 * this is GenActionBar's pill swap: `Stop generation` is wider than
 * `Regenerate`, so the `New content` / `Rating` pills shift sideways every
 * time the lifecycle state flips.
 *
 * The wiring is Svelte-5 specific. We need to snapshot the DOM BEFORE the
 * reactive change commits and replay BETWEEN snapshot and commit. That's
 * what `$effect.pre` is for: it runs in the same flush as the change, but
 * before any DOM mutation. `$effect` then runs after the commit, with the
 * new layout already in place.
 */
import { Flip } from "gsap/Flip";

import { gsap } from "./gsap";
import { prefersReducedMotion } from "./reduced-motion";
import { tokens } from "./tokens";

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  gsap.registerPlugin(Flip);
  registered = true;
}

interface FlipOnChangeOptions {
  /** Tween duration in seconds. Defaults to `tokens.quick`. */
  duration?: number;
  /** Ease string. Defaults to the project's `ease-out-expo` curve. */
  ease?: string;
}

/**
 * Animate children of `getNode()` to their new positions whenever
 * `getKey()` changes. Call from component initialisation (top-level of a
 * `<script>` block). Both arguments are thunks so the helper can subscribe
 * to reactive state.
 *
 * Reduced motion short-circuits — the snapshot is still refreshed each
 * change, but Flip.from is skipped.
 */
export function setupFlipOnChange(
  getNode: () => HTMLElement | null | undefined,
  getKey: () => unknown,
  options: FlipOnChangeOptions = {},
): void {
  ensureRegistered();

  let prevState: ReturnType<typeof Flip.getState> | null = null;
  let prevKey: unknown = Symbol("uninitialised");

  $effect.pre(() => {
    const node = getNode();
    const key = getKey();
    if (!node) return;
    if (key === prevKey) return;
    prevState = Flip.getState(node.children);
  });

  $effect(() => {
    const node = getNode();
    const key = getKey();
    if (!node) return;
    if (key === prevKey) return;
    prevKey = key;
    if (!prevState) return;
    if (prefersReducedMotion()) {
      prevState = null;
      return;
    }
    Flip.from(prevState, {
      duration: options.duration ?? tokens.quick,
      ease: options.ease ?? `cubic-bezier(${tokens.easeOutExpo})`,
      absolute: false,
    });
    prevState = null;
  });
}
