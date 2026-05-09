<script lang="ts">
	// ── Dotmatrix spinner component ──────────────────────────────────────
	// Faithful Svelte port of the dotmatrix loaders from
	// https://dotmatrix.zzzzshawn.cloud (github.com/zzzzshawn/matrix).
	//
	// Three variants driven by CSS keyframes (delay keyed on per-dot CSS vars):
	//   ripple   — center-out radial pulse (manhattan distance)
	//   diagonal — top-left → bottom-right sweep (row + col)
	//   collapse — outside-in ring collapse (4 - manhattan)
	//
	// One variant driven by JS frame-stepping:
	//   prism-bloom — dotm-square-14; palindrome through 4 discrete opacity
	//                 frames at ~354ms/step with CSS transition crossfade.
	//
	// Props:
	//   variant — which animation pattern to use
	//   active  — when false, prism-bloom timer is suspended

	type Variant = 'ripple' | 'diagonal' | 'collapse' | 'prism-bloom';

	interface Props {
		variant: Variant;
		active?: boolean;
	}

	let { variant, active = true }: Props = $props();

	// ── 5×5 grid layout ─────────────────────────────────────────────────
	// Pure geometry — precomputed once at module load. Each dot carries:
	//   manhattan     — |row-2| + |col-2|, used by ripple & collapse
	//   pathOrder     — row + col, used by diagonal
	//   collapseOrder — 4 - manhattan, used by collapse
	const MATRIX_5X5 = (() =>
		Array.from({ length: 25 }, (_, i) => {
			const row = Math.floor(i / 5);
			const col = i % 5;
			const manhattan = Math.abs(row - 2) + Math.abs(col - 2);
			return { row, col, manhattan, pathOrder: row + col, collapseOrder: 4 - manhattan };
		}))();

	// ── Prism Bloom sequencer (dotm-square-14) ───────────────────────────
	// Each frame is a 25-char row-major string over the 5×5 grid:
	//   'x' → opacity 1.0 (peak)
	//   'o' → opacity 0.52 (mid)
	//   '.' → opacity 0.08 (dim)
	// Palindrome sequence [0,1,2,3,2,1] repeats at ~354ms/step (~2.1s cycle).
	// CSS transition crossfades between steps (Material easing, 180ms).
	const PRISM_BLOOM_FRAMES = [
		'x...x.x.x...o...x.x.x...x',
		'..x...oxo.xooox.oxo...x...',
		'.x.x.x.o.x..o..x.o.x.x.x.',
		'x.x.x.o.o.x.o.x.o.o.x.x.x',
	] as const;
	const PRISM_BLOOM_SEQUENCE = [0, 1, 2, 3, 2, 1] as const;
	const PRISM_BLOOM_STEP_MS = 354;

	let prismBloomStep = $state(0);

	$effect(() => {
		if (!active || variant !== 'prism-bloom') return;
		let frame: ReturnType<typeof setTimeout>;
		let seq = 0;
		function tick() {
			seq = (seq + 1) % PRISM_BLOOM_SEQUENCE.length;
			prismBloomStep = PRISM_BLOOM_SEQUENCE[seq] ?? 0;
			frame = setTimeout(tick, PRISM_BLOOM_STEP_MS);
		}
		frame = setTimeout(tick, PRISM_BLOOM_STEP_MS);
		return () => clearTimeout(frame);
	});

	function getPrismBloomOpacity(dotIdx: number): number {
		const frame = PRISM_BLOOM_FRAMES[prismBloomStep] ?? PRISM_BLOOM_FRAMES[0]!;
		const char = frame[dotIdx] ?? '.';
		if (char === 'x') return 1;
		if (char === 'o') return 0.52;
		return 0.08;
	}
</script>

<span class="dotmatrix dotmatrix--{variant}" aria-hidden="true">
	{#each MATRIX_5X5 as dot, dotIdx (dotIdx)}
		<span
			class="dotmatrix-dot"
			style={variant === 'prism-bloom'
				? `opacity: ${getPrismBloomOpacity(dotIdx)};`
				: `--manhattan: ${dot.manhattan}; --path-order: ${dot.pathOrder}; --collapse-order: ${dot.collapseOrder};`}
		></span>
	{/each}
</span>

<style>
	/* ── Dotmatrix spinner ──────────────────────────────────────────────
	   5×5 grid of circular dots. CSS-driven variants (ripple, diagonal,
	   collapse) animate via keyframe delay on per-dot CSS vars.
	   Prism Bloom (dotm-square-14) is JS-driven: opacity set inline,
	   crossfaded by CSS transition. Color inherits from currentColor —
	   set var(--color-accent) on the wrapper to theme it. */

	.dotmatrix {
		display: inline-grid;
		grid-template-columns: repeat(5, 5px);
		grid-template-rows: repeat(5, 5px);
		gap: 1px;
		flex-shrink: 0;
		color: var(--color-accent);
		--dotmatrix-cycle: 1500ms;
	}

	.dotmatrix-dot {
		width: 5px;
		height: 5px;
		border-radius: 999px;
		background: currentColor;
		opacity: 0.16;
		will-change: opacity;
	}

	/* Variant: ripple — center-out radial pulse.
	   Delay scales with manhattan distance from center. */
	.dotmatrix--ripple .dotmatrix-dot {
		animation: dotmatrix-pulse var(--dotmatrix-cycle) cubic-bezier(0.42, 0, 0.58, 1) infinite;
		animation-delay: calc(var(--manhattan, 0) * 0.18 * var(--dotmatrix-cycle));
	}

	/* Variant: diagonal — top-left → bottom-right sweep.
	   Delay scales with row + col. */
	.dotmatrix--diagonal .dotmatrix-dot {
		animation: dotmatrix-pulse var(--dotmatrix-cycle) linear infinite;
		animation-delay: calc(var(--path-order, 0) * 0.11 * var(--dotmatrix-cycle));
	}

	/* Variant: collapse — outside-in ring collapse.
	   Delay scales with 4 - manhattan so the outer ring fires first. */
	.dotmatrix--collapse .dotmatrix-dot {
		animation: dotmatrix-pulse var(--dotmatrix-cycle) ease-in-out infinite;
		animation-delay: calc(var(--collapse-order, 0) * 0.14 * var(--dotmatrix-cycle));
	}

	@keyframes dotmatrix-pulse {
		0%, 100% { opacity: 0.16; }
		50% { opacity: 1; }
	}

	/* Variant: prism-bloom (dotm-square-14) — JS frame-stepping.
	   Opacity is set inline per dot; this rule provides the crossfade. */
	.dotmatrix--prism-bloom .dotmatrix-dot {
		transition: opacity 180ms cubic-bezier(0.4, 0, 0.2, 1);
		opacity: 0.08;
	}
</style>
