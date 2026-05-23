/**
 * Singleton gsap.matchMedia() that gates every motion-creating call.
 *
 * Reduced-motion contract:
 * - When (prefers-reduced-motion: reduce) is active, presets and actions
 *   normally short-circuit to gsap.set() (apply end state without tweening).
 * - A preset can opt back in by passing `essential: true` to `withMotion`.
 *   Loading spinners and the streaming-AI cursor use this so reduced-motion
 *   users still see liveness affordances.
 *
 * The global @media (prefers-reduced-motion) block in app.css is removed by
 * Phase 7 of the migration plan; once that lands, this module is the SOLE
 * arbiter of reduced motion across the app.
 */
import { gsap } from "./gsap";

let mm: ReturnType<typeof gsap.matchMedia> | null = null;

function getMm(): ReturnType<typeof gsap.matchMedia> {
  if (mm) return mm;
  mm = gsap.matchMedia();
  return mm;
}

export interface MotionConditionFlags {
  reduceMotion: boolean;
  ok: boolean;
}

/**
 * Run a motion-creating block under matchMedia so it's automatically reverted
 * when the media-query state changes. The block receives the resolved
 * conditions; use them to pick a tween vs. a `set` vs. no-op.
 *
 * Returns a disposer that reverts any tweens created inside the block.
 */
export function withMotion(
  fn: (flags: MotionConditionFlags) => void | (() => void),
  options: { essential?: boolean } = {},
): () => void {
  const queries = {
    reduceMotion: "(prefers-reduced-motion: reduce)",
    ok: "(prefers-reduced-motion: no-preference)",
  };
  const context = getMm().add(queries, (ctx) => {
    const conds = (ctx.conditions ?? { reduceMotion: false, ok: true }) as unknown as MotionConditionFlags;
    // Essential animations always run, even under reduce-motion.
    const flags: MotionConditionFlags = options.essential
      ? { reduceMotion: false, ok: true }
      : conds;
    const cleanup = fn(flags);
    return cleanup;
  });
  return () => {
    context?.revert();
  };
}

/**
 * Synchronous read for callers that need a one-shot decision (e.g., a
 * page-transition flow where we can't keep a matchMedia handler alive).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Revert everything ever created through this singleton. Used by HMR and
 * tests. Not called in normal app lifecycle.
 */
export function revertAllMotion(): void {
  mm?.revert();
  mm = null;
}
