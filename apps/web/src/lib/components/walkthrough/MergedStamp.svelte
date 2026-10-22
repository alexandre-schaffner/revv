<script lang="ts">
import { gsap, prefersReducedMotion, tokens } from "$lib/motion";
import { hasContainerAnimated, markContainerAnimated } from "$lib/stores/walkthrough.svelte";
import { formatRelativeTime } from "$lib/utils/format-relative-time";

/**
 * Rubber-stamp mark for a merged PR, pressed into the top-right of the
 * walkthrough. Purely decorative (`pointer-events: none`) — it carries its
 * meaning to assistive tech through `role="img"` + `aria-label`.
 */
interface Props {
  prId: string;
  /** ISO merge timestamp; renders as the stamp's date band when present. */
  mergedAt?: string | undefined;
}

let { prId, mergedAt }: Props = $props();

/**
 * Per-PR press variance. A real stamp never lands twice at the same angle,
 * and every merged PR showing an identical mark is the tell that it's a badge
 * with a filter on it. Both the tilt and the ink grain are seeded off the PR
 * id, so a given PR always stamps the same way (stable across reloads and
 * re-renders) while no two PRs match.
 */
function hash32(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const seedHash = $derived(hash32(prId));
/** -5.0° … -9.4°: enough variance to read as hand-pressed, never as broken. */
const tiltDeg = $derived(-(5 + (seedHash % 45) / 10));
const grainSeed = $derived(seedHash % 100);
/**
 * Per-PR filter id — the grain seed differs per PR, so the filter can't be a
 * shared singleton, and two stamps on one page must not collide.
 */
const filterId = $derived(`merged-stamp-ink-${seedHash.toString(36)}`);

const dateBand = $derived.by(() => {
  if (!mergedAt) return null;
  // `new Date(...)`, not `Date.parse`: SSE hands us an ISO string while an
  // Eden fetch revives the same field into a `Date`, and this accepts both.
  const ms = new Date(mergedAt).getTime();
  if (Number.isNaN(ms)) return null;
  return new Date(ms)
    .toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })
    .toUpperCase();
});

const tooltip = $derived(mergedAt ? `Merged ${formatRelativeTime(mergedAt)}` : "Merged");

// One-shot entrance: the stamp presses down once per PR, not on every tab
// revisit. Shares the walkthrough's container-animation ledger so switching
// to the Diff tab and back doesn't replay it.
const ANIMATION_KEY = "merged-stamp";

let el = $state<HTMLDivElement | null>(null);

$effect(() => {
  const node = el;
  const tilt = tiltDeg;
  if (!node) return;
  // The tilt is applied here, not in CSS: GSAP writes `rotate: none` next to
  // its `transform` (it owns the independent transform properties), which
  // silently wipes a CSS `rotate` on the same element.
  if (hasContainerAnimated(prId, ANIMATION_KEY) || prefersReducedMotion()) {
    gsap.set(node, { autoAlpha: 1, scale: 1, rotation: tilt });
    return;
  }
  markContainerAnimated(prId, ANIMATION_KEY);
  // Press, then seat: the die comes down big and over-rotated, lands past
  // its resting angle, and rocks back the last degree — the way a hand-held
  // stamp actually settles. Both steps ease out; no bounce.
  const tl = gsap
    .timeline()
    .fromTo(
      node,
      { autoAlpha: 0, scale: 1.55, rotation: tilt - 9 },
      {
        autoAlpha: 1,
        scale: 1,
        rotation: tilt + 1.2,
        duration: tokens.slow,
        ease: tokens.easeOutExpo,
      },
    )
    .to(node, { rotation: tilt, duration: tokens.smooth, ease: tokens.easeSoft });
  return () => tl.kill();
});
</script>

<!--
  The ink distress. The die itself is crisp — straight rules, even corners —
  and the imperfection is in the *ink*: a dry pad lays colour down unevenly,
  leaving paper-coloured specks all through the stroke. That is a per-pixel
  alpha knock-out, which CSS cannot express, so it comes from an SVG filter:
  fine-grained turbulence, hard-thresholded into a speckle mask, composited
  through the mark's own alpha.

  Grain scale is deliberately fine (baseFrequency 0.85, a single octave):
  the speckle should sit just above the pixel grid so it reads as ink
  texture at a glance. A second octave layers in larger blotches that
  survive at any zoom and make the stamp look damaged instead of pressed.
-->
<svg width="0" height="0" aria-hidden="true" focusable="false" class="stamp-filter-host">
	<filter id={filterId} color-interpolation-filters="sRGB">
		<feTurbulence
			type="fractalNoise"
			baseFrequency="0.85"
			numOctaves="1"
			seed={grainSeed}
			result="grain"
		/>
		<!-- Noise red channel → alpha, so the transfer below can threshold it. -->
		<feColorMatrix
			in="grain"
			type="matrix"
			values="0 0 0 0 0
			        0 0 0 0 0
			        0 0 0 0 0
			        1 0 0 0 0"
			result="grainAlpha"
		/>
		<!-- Near-binary ramp: the mask is either fully opaque or fully clear
		     across ~1px, so the specks are clean holes. A gentler slope leaves
		     half-transparent ink everywhere, which reads as a blurry, washed
		     mark rather than a pressed one. Only the low tail of the noise
		     (n < 0.26) punches through, keeping the ink mostly solid — the
		     mark should read as dry ink, not as a chewed-up die. Push the
		     threshold past ~0.3 and the erosion starts eating the rule and
		     the glyphs: the border breaks into a dashed line and the word
		     grows holes, which is noise rather than texture. -->
		<feComponentTransfer in="grainAlpha" result="speckle">
			<feFuncA type="linear" slope="10" intercept="-2.6" />
		</feComponentTransfer>
		<feComposite in="SourceGraphic" in2="speckle" operator="in" />
	</filter>
</svg>

<div
	bind:this={el}
	class="merged-stamp"
	style:filter="url(#{filterId})"
	role="img"
	aria-label={dateBand
		? `This pull request was merged on ${dateBand}`
		: 'This pull request has been merged'}
	title={tooltip}
>
	<span class="stamp-word">Merged</span>
	{#if dateBand}
		<span class="stamp-date">{dateBand}</span>
	{/if}
</div>

<style>
	.stamp-filter-host {
		position: absolute;
		width: 0;
		height: 0;
		overflow: hidden;
	}

	.merged-stamp {
		display: inline-flex;
		flex-direction: column;
		align-items: stretch;
		padding: 7px 16px;
		/* Single bold rule, like a real die — the texture does the work. */
		border: 2.75px solid var(--color-merged);
		border-radius: 5px;
		/* No fill: the plate is bare paper, so the speckle only ever eats into
		   the rule and the glyphs. A tinted fill puts noise across the whole
		   rectangle, which just reads as haze. */
		background: transparent;
		color: var(--color-merged);
		/* Decorative: never eat a click meant for the content beneath it. */
		pointer-events: none;
		user-select: none;
		/* Hidden until the entrance effect runs, so a reload never flashes the
		   untilted, unscaled mark before GSAP takes over. */
		opacity: 0;
		visibility: hidden;
	}

	.stamp-word {
		font-size: 1rem;
		font-weight: 800;
		line-height: 1;
		text-transform: uppercase;
		letter-spacing: 0.22em;
		text-align: center;
		/* Uppercase tracking adds a trailing gap after the last glyph; pull it
		   back so the word sits optically centred inside the die. */
		padding-left: 0.22em;
	}

	/* Date band — the second half of real stamp anatomy, and what makes this
	   ornament carry information instead of only decorating. Mono so the
	   digits sit on an even rhythm under the word. */
	.stamp-date {
		margin-top: 5px;
		padding-top: 4px;
		border-top: 1.5px solid currentColor;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: 600;
		line-height: 1;
		letter-spacing: 0.1em;
		text-align: center;
	}
</style>
