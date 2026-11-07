<script lang="ts">
import { firstEntrance, gsap, prefersReducedMotion, tokens } from "$lib/motion";
import { formatRelativeTime } from "$lib/utils/format-relative-time";

interface Props {
  prId: string;
  /** ISO merge timestamp; renders as the stamp's date band when present. */
  mergedAt?: string | undefined;
}

let { prId, mergedAt }: Props = $props();

/**
 * A real stamp never lands twice at the same angle, so the tilt and ink grain
 * are seeded off the PR id: a given PR always stamps the same way, and no two
 * PRs match.
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
  const ms = new Date(mergedAt).getTime();
  if (Number.isNaN(ms)) return null;
  return new Date(ms)
    .toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })
    .toUpperCase();
});

const tooltip = $derived(mergedAt ? `Merged ${formatRelativeTime(mergedAt)}` : "Merged");

let el = $state<HTMLDivElement | null>(null);

$effect(() => {
  const node = el;
  const tilt = tiltDeg;
  if (!node) return;
  // The tilt is applied here, not in CSS: GSAP writes `rotate: none` next to
  // its `transform` (it owns the independent transform properties), which
  // silently wipes a CSS `rotate` on the same element.
  // The press plays once per PR per session, not on every remount.
  if (!firstEntrance(`merged-stamp:${prId}`) || prefersReducedMotion()) {
    gsap.set(node, { autoAlpha: 1, scale: 1, rotation: tilt });
    return;
  }
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
  The die is crisp; the imperfection is in the ink, a dry pad leaving
  paper-coloured specks through the stroke. That per-pixel alpha knock-out
  is beyond CSS, so it is an SVG filter: fine turbulence, hard-thresholded
  into a speckle mask, composited through the mark's own alpha. One octave
  only: a second layers in blotches that read as damage, not texture.
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
		<!-- Near-binary ramp, so the specks are clean holes rather than a
		     washed, half-transparent mark. Only the low tail (n < 0.26)
		     punches through; past ~0.3 the erosion breaks the rule into
		     dashes and puts holes in the word. -->
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
		border: 2.75px solid var(--color-merged);
		border-radius: 5px;
		/* No fill: a tinted fill spreads the speckle over the whole
		   rectangle as haze. */
		background: transparent;
		color: var(--color-merged);
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
