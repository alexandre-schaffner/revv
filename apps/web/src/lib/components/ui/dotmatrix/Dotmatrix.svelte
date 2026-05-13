<script lang="ts">
	// ── Dotmatrix spinner component ──────────────────────────────────────────
	// Single-dispatch dot-matrix renderer. Every variant — legacy or
	// square-N — flows through `DOTMATRIX_VARIANTS` in `./variants.ts`:
	//
	//   kind: 'css'      → CSS keyframes own the animation. The resolver
	//                      returns optional per-dot CSS vars + an optional
	//                      extra class for variants that fan out to multiple
	//                      keyframes (e.g. square-4 outer vs middle ring).
	//                      Keyframes live in `dotmatrix-loader.css`.
	//
	//   kind: 'stepped'  → JS frame-stepping via setTimeout. The resolver
	//                      computes opacity per dot per step; component
	//                      writes it inline.
	//
	//   kind: 'phase'    → JS continuous phase 0..1 via rAF. Same shape as
	//                      `stepped` but with a 0..1 phase argument.
	//
	// Layout & styling: ALL CSS — grid, dot dimensions, size variants,
	// inactive state, keyframes, variant rules — lives in
	// `./dotmatrix-loader.css` (imported globally via `app.css`). This
	// component has no local `<style>` so its classes are unhashed and the
	// global stylesheet matches by class name alone.
	//
	// Reduced motion: JS variants skip the ticker and render
	// `idleOpacity(...)`. CSS variants are caught by the global
	// `prefers-reduced-motion: reduce` rule in `app.css`. The matrix is
	// decorative variation on top of the always-present `.stream-cursor`
	// (motion-essential), so we don't bypass the global reset.
	//
	// Props:
	//   variant — any `DotmatrixVariant` (24 total: 4 legacy + 20 square-N)
	//   size    — 'default' (5px dots, 29px) | 'small' (3px dots, 19px)
	//   active  — false suspends the JS sequencers

	import {
		DOTMATRIX_VARIANTS,
		type DotmatrixVariant,
		type PerDotConfig,
		type VariantConfig,
	} from './variants';

	interface Props {
		variant: DotmatrixVariant;
		size?: 'default' | 'small';
		active?: boolean;
	}

	let { variant, size = 'default', active = true }: Props = $props();

	// ── 5×5 grid layout — precomputed once ─────────────────────────────────
	const MATRIX_5X5 = (() =>
		Array.from({ length: 25 }, (_, i) => ({
			row: Math.floor(i / 5),
			col: i % 5,
		})))();

	// ── Reduced motion detection ───────────────────────────────────────────
	let reducedMotion = $state(false);
	$effect(() => {
		if (typeof window === 'undefined') return;
		const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
		reducedMotion = mq.matches;
		const update = () => {
			reducedMotion = mq.matches;
		};
		mq.addEventListener('change', update);
		return () => mq.removeEventListener('change', update);
	});

	// ── JS sequencer state (used by 'stepped' and 'phase' variants) ────────
	const config: VariantConfig = $derived(DOTMATRIX_VARIANTS[variant]);
	let stepIdx = $state(0);
	let phase = $state(0);

	// Reset sequencer state when variant changes to prevent out-of-bounds access
	$effect(() => {
		variant; // track
		stepIdx = 0;
		phase = 0;
	});

	$effect(() => {
		const cfg = config;
		if (!active || reducedMotion) return;

		if (cfg.kind === 'stepped') {
			const stepMs = cfg.cycleMs / cfg.stepCount;
			let s = 0;
			let id: ReturnType<typeof setTimeout> = setTimeout(function tick() {
				s = (s + 1) % cfg.stepCount;
				stepIdx = s;
				id = setTimeout(tick, stepMs);
			}, stepMs);
			return () => clearTimeout(id);
		}

		if (cfg.kind === 'phase') {
			const start = performance.now();
			let rafId = 0;
			const tick = (now: number) => {
				const elapsed = ((now - start) % cfg.cycleMs + cfg.cycleMs) % cfg.cycleMs;
				phase = elapsed / cfg.cycleMs;
				rafId = requestAnimationFrame(tick);
			};
			rafId = requestAnimationFrame(tick);
			return () => cancelAnimationFrame(rafId);
		}
	});

	// ── Per-dot resolvers ──────────────────────────────────────────────────

	function dotInlineStyle(idx: number, row: number, col: number): string {
		if (config.kind === 'css') {
			const r = config.resolve(idx, row, col);
			if (r.inactive || !r.vars) return '';
			return Object.entries(r.vars)
				.map(([k, v]) => `${k}: ${v}`)
				.join('; ');
		}
		const op = reducedMotion
			? config.idleOpacity(idx, row, col)
			: config.kind === 'stepped'
				? config.opacity(stepIdx, idx, row, col)
				: config.opacity(phase, idx, row, col);
		return `opacity: ${op};`;
	}

	function dotClass(idx: number, row: number, col: number): string {
		if (config.kind !== 'css') return 'dotmatrix-dot';
		const r: PerDotConfig = config.resolve(idx, row, col);
		if (r.inactive) return 'dotmatrix-dot dotmatrix-dot--inactive';
		return r.className ? `dotmatrix-dot ${r.className}` : 'dotmatrix-dot';
	}
</script>

<span
	class="dotmatrix dotmatrix--{variant} dotmatrix--size-{size}"
	aria-hidden="true"
>
	{#each MATRIX_5X5 as dot, dotIdx (dotIdx)}
		<span class={dotClass(dotIdx, dot.row, dot.col)} style={dotInlineStyle(dotIdx, dot.row, dot.col)}></span>
	{/each}
</span>
