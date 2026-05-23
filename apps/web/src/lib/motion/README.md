# `$lib/motion` — GSAP-backed animation system

Single home for every animation in Revv. **Nothing else in the app imports `gsap`
directly** — call into `$lib/motion` instead.

## Why GSAP

We migrated off mixed CSS transitions + Svelte transitions + ad-hoc keyframes
because they couldn't be choreographed together. GSAP unifies the timing
model, gives us one easing source, and unlocks Flip-based layout morphs we
couldn't write in CSS.

## What lives here

| File | Role |
| --- | --- |
| `gsap.ts` | Plugin registration + project-wide defaults. Imported once from `+layout.svelte`. |
| `tokens.ts` | Typed mirror of the `@theme` motion variables in `app.css`. Reads `getComputedStyle` lazily; ships static fallbacks. |
| `match-media.ts` | Singleton `gsap.matchMedia()` that gates motion on `prefers-reduced-motion`. `withMotion(fn, { essential })`. |
| `presets.ts` | Named recipes (`dialogSpringIn`, `panelSlideIn`, `walkthroughBlockReveal`, …). Each returns a `gsap.timeline()`. |
| `actions.ts` | Svelte `use:` directives (`gsapIn`, `gsapPress`, `gsapHover`, `bitsAnim`). |
| `transitions.ts` | Drop-in replacements for `svelte/transition` (`gsapFade`, `gsapFadeY`, `gsapSlide`, `gsapScale`). |
| `page-transitions.ts` | `setupPageTransitions()` — registers `beforeNavigate`/`afterNavigate` for crossfade + Flip morphs. |
| `index.ts` | Public re-exports. Prefer `from "$lib/motion"`. |

## How to add an animation

```svelte
<script lang="ts">
  import { gsapIn, walkthroughBlockReveal } from "$lib/motion";
</script>

<div use:gsapIn={{ preset: walkthroughBlockReveal }}>
  …
</div>
```

For state-driven (bits-ui) primitives:

```svelte
<script lang="ts">
  import { bitsAnim, dialogSpringIn, dialogSpringOut } from "$lib/motion";
</script>

<bits-dialog-content
  use:bitsAnim={{
    inPreset: dialogSpringIn,
    outPreset: dialogSpringOut,
  }}
>
  …
</bits-dialog-content>
```

For an imperative timeline (e.g., the walkthrough phase A→D choreography):

```ts
import { gsap, walkthroughBlockReveal, phaseDotLight, withMotion } from "$lib/motion";

withMotion(({ reduceMotion }) => {
  if (reduceMotion) return;
  const t = gsap.timeline()
    .add(walkthroughBlockReveal(blockEl))
    .add(phaseDotLight(dotEl), ">-0.1");
  return () => t.kill();
});
```

## Reduced motion

`gsap.matchMedia()` (via `withMotion`) is the **single** arbiter. The global
`@media (prefers-reduced-motion: reduce)` block in `app.css` is removed by
Phase 7. Until then, the CSS block is defensive coverage for any
not-yet-migrated CSS transition.

A preset can opt back in (loading indicators, stream cursor) by setting
`preset.essential = true`. The `gsapIn` action and `withMotion` pass that
through automatically.

## Token bridge

`tokens.ts` mirrors the values in `app.css:523-552`. **If you change a
duration or easing, change both.** A comment in `app.css` points here as a
reminder.

GSAP wants durations in seconds; CSS uses ms. `tokens.snap` etc. are
already in seconds. Easings are passed to GSAP as the raw
`cubic-bezier(...)` string, which it accepts via CSSPlugin / parser.

## Bundle cost

`gsap` core + `Flip` + `Observer` + `Draggable` + `ScrollTrigger` weighs
~50–60 KB gzipped. Code-split by route via Vite default. None of the Club
GSAP plugins are used (SplitText, MorphSVG, DrawSVG, ScrollSmoother,
CustomBounce all stay out).

## Allowed CSS transitions after Phase 7

After the global reduced-motion block is removed, any remaining CSS
`transition:` is forbidden **for motion**. The exceptions are:

- Theme switch background-color crossfade on `:root` — color is a paint
  property, not motion; GSAP would still tween it but the CSS variable
  swap is simpler and theme-aware.
- Form-control native states (`accent-color` etc.) inherited from the
  browser default.

If you find a need to add a new CSS transition, justify it here.
