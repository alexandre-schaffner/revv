# `$lib/motion` — GSAP-backed animation system

Single home for app animation. **Nothing else in the app imports `gsap`
directly** — call into `$lib/motion` instead.

## Why GSAP

We migrated off mixed CSS transitions + Svelte transitions + ad-hoc keyframes
because they couldn't be choreographed together. GSAP unifies the timing
model, gives us one easing source, and lets us run coordinated multi-target
timelines (right-panel slide + vignette crossfade).

## Files

| File | Role |
| --- | --- |
| `gsap.ts` | GSAP + `CustomEase` registration; `overwrite:auto` default. |
| `tokens.ts` | Flat const mirror of the `@theme` motion variables in `app.css`. |
| `reduced-motion.ts` | `prefersReducedMotion()` — the single arbiter. |
| `presets.ts` | Timelines for bits-ui content (`dialogSpringIn`, `popoverPopIn`, `tooltipPopIn`, …). |
| `actions.ts` | `gsapPress` (button feedback) and `bitsAnim` (drives bits-ui content from `data-state`). |
| `transitions.ts` | Svelte custom transitions (`gsapFade`, `gsapFadeY`, `gsapSlide`). |
| `grid-choreography.ts` | `tweenGridTrack` and `useRightPanelChoreography` for the AppShell. |
| `index.ts` | Public surface — `from "$lib/motion"`. |

## How to use

```svelte
<script>
  import { gsapPress, gsapFadeY, tokens } from "$lib/motion";
</script>

<button use:gsapPress>Save</button>

<div in:gsapFadeY={{ y: 8, duration: tokens.smooth }}>
  …
</div>
```

For a bits-ui content surface:

```svelte
<script>
  import { bitsAnim, dialogSpringIn, dialogSpringOut } from "$lib/motion";
</script>

<div data-state="open" use:bitsAnim={{ inPreset: dialogSpringIn, outPreset: dialogSpringOut }}>
  …
</div>
```

## Tokens

`tokens.ts` is a flat const object. **If you change a duration or ease, edit
both `tokens.ts` and the `@theme` block in `app.css`.**

GSAP wants seconds; CSS uses ms. The eases are stored as bare cubic-bezier
control points because `CustomEase` parses any string starting with a digit.

## Reduced motion

`prefersReducedMotion()` is the **single arbiter**. Every action, preset
call site, and motion `$effect` reads through it. There is no `gsap.matchMedia`
wrapper — the synchronous check is enough for every case we have.

The defensive `@media (prefers-reduced-motion: reduce)` block in `app.css`
covers the CSS animations that intentionally stayed off GSAP — see the
"Surviving CSS animations" section below.

## Surviving CSS animations

Kept off GSAP by design — moving them would be a regression:

- **`motion-essential-spin`** — loader spinner. Compositor-only paint, runs on
  many surfaces simultaneously; a GSAP infinite tween would burn rAF for an
  indicator that exists on ~7 places at once.
- **`text-shimmer-sweep`** — continuous `background-position` sweep on streamed
  AI text. Per-glyph GSAP would not be cheaper.
- **`indeterminate-progress`** — single element, low cost, runs only when active.
- **`sd-char-in` / `.sd-char-new`** — per-character fade on markdown injected
  via `{@html}`. No Svelte handle for `use:`, so a keyframe is the right tool.
- **Dotmatrix variants** — three animation kinds with their own reduced-motion
  handling; ~24 variants, no visible improvement from migration.
- **`transition: background-color` / `color`** on hover states — compositor
  paint crossfades on dozens of list items.
