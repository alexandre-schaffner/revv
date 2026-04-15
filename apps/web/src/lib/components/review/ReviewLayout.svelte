<script lang="ts">
	import type { ReviewFile } from '$lib/types/review';
	import DiffViewer from './DiffViewer.svelte';
	import TokenTooltip from './TokenTooltip.svelte';
	import {
		getActiveFilePath,
		setActiveFilePath,
		setDiffMode,
		requestExplanation,
		acceptHunk,
		rejectHunk
	} from '$lib/stores/review.svelte';
	import { getActivePanel, enterSidebarMode, enterDiffMode } from '$lib/stores/focus-mode.svelte';
	import type { TokenHoverInfo } from './DiffViewerInner.svelte';

	// ── Props ─────────────────────────────────────────────────────────────────

	interface Props {
		prId: string;
		files: ReviewFile[];
		themeType?: 'light' | 'dark' | 'system';
	}

	let { prId, files, themeType = 'dark' }: Props = $props();

	// ── Layout state ──────────────────────────────────────────────────────────

	const activeFilePath = $derived(getActiveFilePath());
	const activeFile = $derived(files.find((f) => f.path === activeFilePath) ?? null);

	// ── Focused hunk tracking (for a/x keyboard shortcuts) ───────────────────

	/** The hunk index currently under the mouse cursor, or null if none. */
	let focusedHunkIndex = $state<number | null>(null);

	function handleDiffMouseover(e: MouseEvent) {
		const el = (e.target as HTMLElement).closest('[data-hunk-index]');
		if (!el) return;
		const raw = el.getAttribute('data-hunk-index');
		if (raw === null) return;
		const idx = parseInt(raw, 10);
		if (Number.isNaN(idx)) return;
		focusedHunkIndex = idx;
	}

	function handleDiffMouseleave() {
		focusedHunkIndex = null;
	}

	// ── Token hover state ────────────────────────────────────────────────────

	interface TokenHoverState {
		tokenText: string;
		x: number;
		y: number;
		lineNumber: number;
		side: string;
	}
	let tokenHover = $state<TokenHoverState | null>(null);
	let tokenHoverTimer: ReturnType<typeof setTimeout> | null = null;

	function handleTokenHover(info: TokenHoverInfo | null) {
		if (tokenHoverTimer !== null) {
			clearTimeout(tokenHoverTimer);
			tokenHoverTimer = null;
		}
		if (!info) {
			tokenHoverTimer = setTimeout(() => {
				tokenHover = null;
			}, 150);
			return;
		}
		const rect = info.element.getBoundingClientRect();
		tokenHover = {
			tokenText: info.tokenText,
			x: rect.left,
			y: rect.top,
			lineNumber: info.lineNumber,
			side: info.side
		};
	}

	// ── Keyboard navigation ──────────────────────────────────────────────────

	/** Scroll amount per j/k press (in pixels). */
	const SCROLL_STEP = 80;

	/** State for the `gg` two-key sequence (scroll to top in diff mode). */
	let pendingG = false;
	let gTimer: ReturnType<typeof setTimeout> | undefined;

	function getDiffScroll(): HTMLElement | null {
		return document.querySelector<HTMLElement>('.diff-scroll');
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

		const inDiffMode = getActivePanel() === 'diff';

		// ── Space toggles between sidebar ↔ diff (handled here to avoid double-fire) ──
		if (e.key === ' ') {
			e.preventDefault();
			if (inDiffMode) {
				enterSidebarMode();
			} else {
				enterDiffMode();
			}
			return;
		}

		// ── Diff-mode bindings ─────────────────────────────────────────
		if (inDiffMode) {
			if (e.key === 'Escape') {
				e.preventDefault();
				enterSidebarMode();
				return;
			}

			// j / k / ArrowDown / ArrowUp → scroll the diff container
			if (e.key === 'j' || e.key === 'ArrowDown') {
				e.preventDefault();
				getDiffScroll()?.scrollBy({ top: SCROLL_STEP, behavior: 'instant' });
				return;
			}
			if (e.key === 'k' || e.key === 'ArrowUp') {
				e.preventDefault();
				getDiffScroll()?.scrollBy({ top: -SCROLL_STEP, behavior: 'instant' });
				return;
			}

			// d / u → half-page scroll (vim Ctrl-D / Ctrl-U style)
			if (e.key === 'd') {
				e.preventDefault();
				const el = getDiffScroll();
				if (el) el.scrollBy({ top: el.clientHeight / 2, behavior: 'instant' });
				return;
			}
			if (e.key === 'u') {
				e.preventDefault();
				const el = getDiffScroll();
				if (el) el.scrollBy({ top: -el.clientHeight / 2, behavior: 'instant' });
				return;
			}

			// G → scroll to bottom
			if (e.key === 'G') {
				e.preventDefault();
				pendingG = false;
				if (gTimer !== undefined) clearTimeout(gTimer);
				const el = getDiffScroll();
				if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
				return;
			}

			// gg → scroll to top (two-key sequence)
			if (e.key === 'g' && !e.shiftKey) {
				if (pendingG) {
					e.preventDefault();
					pendingG = false;
					if (gTimer !== undefined) clearTimeout(gTimer);
					const el = getDiffScroll();
					if (el) el.scrollTo({ top: 0, behavior: 'instant' });
					return;
				}
				pendingG = true;
				gTimer = setTimeout(() => {
					pendingG = false;
				}, 300);
				e.preventDefault();
				return;
			}

			// Any other diff-mode key cancels pending g
			if (pendingG) {
				pendingG = false;
				if (gTimer !== undefined) clearTimeout(gTimer);
			}
		}

		// ── Shared bindings (both modes) ──────────────────────────────
		if (e.key === 'n') {
			e.preventDefault();
			navigateFile(1);
		} else if (e.key === 'p') {
			e.preventDefault();
			navigateFile(-1);
		} else if (e.key === 'a' && focusedHunkIndex !== null) {
			e.preventDefault();
			if (activeFilePath) acceptHunk(activeFilePath, focusedHunkIndex);
		} else if (e.key === 'x' && focusedHunkIndex !== null) {
			e.preventDefault();
			if (activeFilePath) rejectHunk(activeFilePath, focusedHunkIndex);
		}
	}

	function navigateFile(direction: 1 | -1) {
		const currentIdx = files.findIndex((f) => f.path === activeFilePath);
		const nextIdx = currentIdx + direction;
		if (nextIdx >= 0 && nextIdx < files.length) {
			setActiveFilePath(files[nextIdx]!.path);
		}
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="review-layout">
	<!-- @pierre/diffs renderer -->
	<div
		class="diff-scroll"
		class:diff-scroll--focused={getActivePanel() === 'diff'}
		tabindex="-1"
		onmouseover={handleDiffMouseover}
		onfocus={() => {}}
		onmouseleave={handleDiffMouseleave}
		role="presentation"
	>
		<DiffViewer
			file={activeFile}
			{themeType}
			onModeChange={(m) => setDiffMode(m)}
			onTokenHover={handleTokenHover}
		/>
	</div>
</div>

<!-- Floating overlays (outside shadow DOM, positioned via fixed coords) -->

{#if tokenHover}
	<TokenTooltip
		tokenText={tokenHover.tokenText}
		x={tokenHover.x}
		y={tokenHover.y}
		onExplain={() => {
			const hover = tokenHover;
			if (hover && activeFilePath) {
				requestExplanation({
					prId,
					filePath: activeFilePath,
					lineRange: [hover.lineNumber, hover.lineNumber],
					codeSnippet: hover.tokenText
				});
			}
			tokenHover = null;
		}}
		onDismiss={() => {
			tokenHover = null;
		}}
	/>
{/if}

<style>
	.review-layout {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		background: var(--color-diff-bg);
	}

	/* Diff scroll area — @pierre/diffs only handles *horizontal* scroll
	   internally (the <code> elements use overflow: scroll clip, i.e.
	   overflow-x:scroll / overflow-y:clip). Vertical scrolling must come
	   from this outer container. */
	.diff-scroll {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		min-height: 0;
		outline: none;
		border-top: 2px solid transparent;
		transition: border-color 0.15s ease;
	}

	.diff-scroll--focused {
		border-top-color: var(--color-accent);
	}
</style>
