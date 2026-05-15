<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Sun, Moon, Monitor } from '@lucide/svelte';
	import { Dotmatrix, type DotmatrixVariant } from '$lib/components/ui/dotmatrix';
	import { getThemePreference, setThemePreference, type ThemePreference } from '$lib/stores/theme.svelte';

	/**
	 * Cinematic frame for the onboarding flow. Calm, dark, type-led: a
	 * book-chapter feel rather than a SaaS welcome modal. Owns the
	 * letterboxed canvas, a small persistent brand glyph, a chapter label,
	 * the serif title, and a tiny dotmatrix that ticks in the corner so
	 * the page never feels static.
	 *
	 * Everything below the chapter label flows from `children`; the shell
	 * itself never pushes a card or a shadow — visual hierarchy comes from
	 * typography and breathing room, not container chrome.
	 */

	type StepId = 'welcome' | 'host' | 'signin' | 'repo' | 'done';

	interface Props {
		stepId: StepId;
		stepIndex: number;
		totalSteps: number;
		chapter: string;
		title: string;
		titleItalic?: string | undefined;
		spinnerVariant?: DotmatrixVariant | undefined;
		children: Snippet;
	}

	let {
		stepId,
		stepIndex,
		totalSteps,
		chapter,
		title,
		titleItalic,
		spinnerVariant = 'square-3',
		children,
	}: Props = $props();

	let pageNumber = $derived(String(stepIndex + 1).padStart(2, '0'));
	let pageTotal = $derived(String(totalSteps).padStart(2, '0'));

	const theme = $derived(getThemePreference());
	const cycle: Record<ThemePreference, ThemePreference> = { system: 'light', light: 'dark', dark: 'system' };
	const labels: Record<ThemePreference, string> = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' };
	function cycleTheme() { setThemePreference(cycle[theme]); }
</script>

<div class="onboarding-shell" data-step={stepId}>
	<div class="grain" aria-hidden="true"></div>
	<div class="vignette" aria-hidden="true"></div>

	<!-- Header: tiny brand glyph + step counter. Persistent across all
	     steps — the eye anchors here rather than chasing a morphing logo. -->
	<header class="header" data-tauri-drag-region>
		<div class="header-left">
			<img src="/icon.svg" alt="Revv" class="brand-glyph" />
			<span class="brand-word">Revv</span>
		</div>
		<div class="header-right">
			<Dotmatrix variant={spinnerVariant} size="small" />
			<span class="page-counter">
				<span class="page-num">{pageNumber}</span>
				<span class="page-sep">/</span>
				<span class="page-total">{pageTotal}</span>
			</span>
			<button class="theme-btn" onclick={cycleTheme} aria-label={labels[theme]} title={labels[theme]}>
				{#if theme === 'light'}
					<Sun size={13} />
				{:else if theme === 'dark'}
					<Moon size={13} />
				{:else}
					<Monitor size={13} />
				{/if}
			</button>
		</div>
	</header>

	<!-- Main column. The title block + content occupies a narrow center
	     column for that book-page measure. -->
	<main class="stage">
		<div class="title-block">
			<div class="chapter-label" data-key={stepIndex}>
				<span class="chapter-rule"></span>
				<span class="chapter-text">{chapter}</span>
			</div>
			<h1 class="title" data-key={stepIndex}>
				<span class="title-line">{title}</span>
				{#if titleItalic}
					<span class="title-line title-italic">{titleItalic}</span>
				{/if}
			</h1>
		</div>

		<div class="content" data-key={stepIndex}>
			{@render children()}
		</div>
	</main>

	<!-- Footer: thin progress bar made of cells. -->
	<footer class="footer">
		<div class="cells">
			{#each Array(totalSteps) as _, i (i)}
				<div
					class="cell"
					data-state={i < stepIndex ? 'past' : i === stepIndex ? 'current' : 'future'}
				></div>
			{/each}
		</div>
	</footer>
</div>

<style>
	.onboarding-shell {
		position: fixed;
		inset: 0;
		isolation: isolate;
		overflow: hidden;
		background: var(--ob-bg);
		color: var(--ob-text);
		display: grid;
		grid-template-rows: auto 1fr auto;
		grid-template-columns: 1fr;
		font-family: var(--font-sans, 'Inter', system-ui, sans-serif);

		/* Slow-cinema tokens, longer than the rest of the app. */
		--ob-dur-slow: 720ms;
		--ob-dur-medium: 480ms;
		--ob-dur-quick: 280ms;
		--ob-ease: cubic-bezier(0.22, 0.61, 0.36, 1);
		--ob-ease-out: cubic-bezier(0.16, 1, 0.3, 1);

		/* ── Light mode (default) ───────────────────────────────────── */
		--ob-bg: #faf9f6;
		--ob-text: #2a2825;
		--ob-text-heading: #1a1816;
		--ob-text-heading-bright: #0f0e0c;
		--ob-text-body: #5a5650;
		--ob-text-label: #7a756c;
		--ob-text-muted: #9a958c;
		--ob-text-dimmed: #c4bfb6;
		--ob-text-italic: #6b5d3e;
		--ob-text-row: #3a3632;
		--ob-border: #e4e0d8;
		--ob-border-subtle: #ece8e0;
		--ob-border-btn: #c4bfb6;
		--ob-error: #b5494b;
		--ob-error-border: #d4888a;
		--ob-cell-default: #e4e0d8;
		--ob-cell-past: #a89e8c;
		--ob-cell-current: #6b5d3e;
		--ob-row-highlight: rgba(107, 93, 62, 0.05);
		--ob-hover-subtle: rgba(0, 0, 0, 0.02);
		--ob-grain-color: rgba(0, 0, 0, 0.4);
	}

	/* ── Dark mode ──────────────────────────────────────────────── */
	:global(html.dark) .onboarding-shell {
		--ob-bg: #0a0a0c;
		--ob-text: #e6e4dc;
		--ob-text-heading: #f0ede4;
		--ob-text-heading-bright: #f7f4ec;
		--ob-text-body: #b4b0a4;
		--ob-text-label: #8a8678;
		--ob-text-muted: #6f6c63;
		--ob-text-dimmed: #4a4842;
		--ob-text-italic: #d4cab2;
		--ob-text-row: #d4d1c6;
		--ob-border: #2a2925;
		--ob-border-subtle: #1b1a18;
		--ob-border-btn: #46443d;
		--ob-error: #c98a8a;
		--ob-error-border: #6f3a3a;
		--ob-cell-default: #2a2925;
		--ob-cell-past: #6a6253;
		--ob-cell-current: #d4cab2;
		--ob-row-highlight: rgba(212, 202, 178, 0.05);
		--ob-hover-subtle: rgba(255, 255, 255, 0.02);
		--ob-grain-color: rgba(255, 255, 255, 0.8);
	}

	/* Film-grain — a barely-perceptible noise that lifts the canvas off
	 perfect black so it reads as a "scene" rather than dead space. Pure
	 CSS, very cheap. */
	.grain {
		position: absolute;
		inset: -50%;
		pointer-events: none;
		opacity: 0.05;
		background-image: radial-gradient(
				1px 1px at 8% 12%,
				var(--ob-grain-color),
				transparent 50%
			),
			radial-gradient(1px 1px at 28% 42%, var(--ob-grain-color), transparent 50%),
			radial-gradient(1px 1px at 48% 72%, var(--ob-grain-color), transparent 50%),
			radial-gradient(1px 1px at 68% 32%, var(--ob-grain-color), transparent 50%),
			radial-gradient(1px 1px at 88% 88%, var(--ob-grain-color), transparent 50%);
		background-size: 200px 200px;
		animation: grain-drift 16s steps(8) infinite;
		z-index: 0;
	}

	@keyframes grain-drift {
		0%, 100% { transform: translate(0, 0); }
		25% { transform: translate(-2%, 1%); }
		50% { transform: translate(1%, -1%); }
		75% { transform: translate(-1%, -2%); }
	}

	/* Letterbox vignette — darkens the edges. Very subtle, not a spotlight. */
	.vignette {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background:
			radial-gradient(
				ellipse at center,
				transparent 50%,
				rgba(0, 0, 0, 0.15) 100%
			);
		z-index: 1;
	}

	:global(html.dark) .vignette {
		background:
			radial-gradient(
				ellipse at center,
				transparent 50%,
				rgba(0, 0, 0, 0.4) 100%
			);
	}

	/* Header bar */
	.header {
		grid-row: 1;
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 28px 36px;
		z-index: 2;
		animation: fade-up var(--ob-dur-slow) var(--ob-ease-out) backwards;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.brand-glyph {
		width: 22px;
		height: 22px;
		border-radius: 5px;
		display: block;
	}

	.brand-word {
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 17px;
		font-weight: 500;
		letter-spacing: 0.01em;
		color: var(--ob-text-italic);
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.page-counter {
		display: inline-flex;
		align-items: baseline;
		gap: 4px;
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 11px;
		letter-spacing: 0.12em;
		color: var(--ob-text-muted);
	}

	.page-num {
		color: var(--ob-text-italic);
	}

	.page-sep {
		color: var(--ob-text-dimmed);
		font-weight: 300;
	}

	.theme-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border: 1px solid var(--ob-border-btn);
		border-radius: 4px;
		background: transparent;
		color: var(--ob-text-muted);
		cursor: pointer;
		transition: color var(--duration-snap) var(--ease-out-expo), border-color var(--duration-snap) var(--ease-out-expo);
	}

	.theme-btn:hover {
		color: var(--ob-text-italic);
		border-color: var(--ob-text-italic);
	}

	/* Stage — title + content column */
	.stage {
		grid-row: 2;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		padding: 32px 24px;
		gap: 48px;
		z-index: 2;
		width: min(640px, 92vw);
		justify-self: center;
	}

	.title-block {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 24px;
		width: 100%;
	}

	.chapter-label {
		display: flex;
		align-items: center;
		gap: 14px;
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.28em;
		text-transform: uppercase;
		color: var(--ob-text-label);
	}

	.chapter-label[data-key] {
		animation: fade-up var(--ob-dur-medium) var(--ob-ease-out) backwards;
	}

	.chapter-rule {
		display: block;
		width: 36px;
		height: 1px;
		background: var(--ob-text-dimmed);
	}

	.title {
		font-family: 'Newsreader', Georgia, serif;
		font-weight: 400;
		font-size: clamp(34px, 5.2vw, 54px);
		line-height: 1.08;
		letter-spacing: -0.015em;
		color: var(--ob-text-heading);
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.title[data-key] .title-line {
		animation: title-reveal var(--ob-dur-slow) var(--ob-ease-out) backwards;
	}

	.title[data-key] .title-line:nth-child(2) {
		animation-delay: 120ms;
	}

	.title-italic {
		font-style: italic;
		color: var(--ob-text-italic);
	}

	.content {
		width: 100%;
		display: flex;
		flex-direction: column;
		animation: fade-up var(--ob-dur-slow) var(--ob-ease-out) 200ms backwards;
	}

	/* Footer — segmented progress bar */
	.footer {
		grid-row: 3;
		padding: 24px 36px 32px;
		z-index: 2;
		animation: fade-up var(--ob-dur-slow) var(--ob-ease-out) backwards;
	}

	.cells {
		display: flex;
		gap: 4px;
		width: 100%;
		max-width: 280px;
	}

	.cell {
		flex: 1;
		height: 2px;
		background: var(--ob-cell-default);
		transition: background-color var(--duration-snap) var(--ease-out-expo);
	}

	.cell[data-state='past'] {
		background: var(--ob-cell-past);
	}

	.cell[data-state='current'] {
		background: var(--ob-cell-current);
	}

	@keyframes fade-up {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@keyframes title-reveal {
		from {
			opacity: 0;
			transform: translateY(14px);
			filter: blur(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
			filter: blur(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.grain {
			animation: none;
		}
		.header,
		.chapter-label,
		.title .title-line,
		.content,
		.footer {
			animation: none !important;
		}
	}
</style>
