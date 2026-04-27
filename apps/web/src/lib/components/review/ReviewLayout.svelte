<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { ReviewFile } from '$lib/types/review';
	import DiffViewer from './DiffViewer.svelte';
	import FileIssues from './FileIssues.svelte';
	import {
		getActiveFilePath,
		setActiveFilePath,
		setDiffMode
	} from '$lib/stores/review.svelte';
	import {
		getActivePanel,
		enterSidebarMode,
		enterScrollMode,
		enterLineMode,
		enterVisualMode,
		exitVisualMode,
		moveCursor,
		jumpCursor,
		getCursorLineIndex,
		getCursorSide,
		getAnchorLineIndex,
		getTotalLineCount,
		isInDiffMode
	} from '$lib/stores/focus-mode.svelte';
	import { setTopbarSubtitle } from '$lib/stores/topbar.svelte';

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
	const activeFileName = $derived(activeFile ? (activeFile.path.split('/').pop() ?? activeFile.path) : '');

	// ── Token hover state ────────────────────────────────────────────────────
	//
	// The legacy explanation feature wired sparkle-tooltip explanations to
	// token hover. With the right pane now hosting the chat agent, that
	// affordance was removed — see CLAUDE.md "AI chat" doctrine. Keeping the
	// `fileTitleSectionEl` ref because other parts of this component bind to it.
	let fileTitleSectionEl = $state<HTMLElement | null>(null);

	// ── Comment trigger ──────────────────────────────────────────────────────

	/**
	 * Passed to DiffViewer to trigger opening a comment input.
	 * Use `seq: Date.now()` to ensure reactivity even for repeated requests.
	 */
	let pendingCommentTrigger = $state<{
		startLine: number;
		endLine: number;
		side: 'additions' | 'deletions';
		seq: number;
	} | null>(null);

	function openComment(startLine: number, endLine: number, side: 'additions' | 'deletions') {
		pendingCommentTrigger = { startLine, endLine, side, seq: Date.now() };
	}

	// ── Timer cleanup ────────────────────────────────────────────────────────

	// ── Topbar subtitle (show full path when file title scrolls out) ─────────
	let fileTitleObserver: IntersectionObserver | null = null;

	function setupFileTitleObserver() {
		if (fileTitleObserver) {
			fileTitleObserver.disconnect();
			fileTitleObserver = null;
		}
		if (!fileTitleSectionEl) {
			setTopbarSubtitle(null);
			return;
		}
		fileTitleObserver = new IntersectionObserver(
			([entry]) => {
				setTopbarSubtitle(entry?.isIntersecting ? null : activeFilePath || null);
			},
			{ threshold: 0 }
		);
		fileTitleObserver.observe(fileTitleSectionEl);
	}

	$effect(() => {
		setupFileTitleObserver();
		return () => {
			if (fileTitleObserver) {
				fileTitleObserver.disconnect();
				fileTitleObserver = null;
			}
			setTopbarSubtitle(null);
		};
	});

	// Keep subtitle in sync when file changes while title is scrolled out of view
	$effect(() => {
		activeFilePath; // track
		if (fileTitleObserver) setupFileTitleObserver();
	});

	onDestroy(() => {
		if (gTimer !== undefined) clearTimeout(gTimer);
		if (fileTitleObserver) fileTitleObserver.disconnect();
		setTopbarSubtitle(null);
	});

	// ── Keyboard navigation ──────────────────────────────────────────────────

	/** Scroll amount per j/k press (in pixels). */
	const SCROLL_STEP = 80;

	/** State for the `gg` / `G` two-key sequence. */
	let pendingG = false;
	let gTimer: ReturnType<typeof setTimeout> | undefined;

	function getDiffScroll(): HTMLElement | null {
		return document.querySelector<HTMLElement>('.diff-scroll');
	}

	function navigateFile(direction: 1 | -1) {
		const currentIdx = files.findIndex((f) => f.path === activeFilePath);
		const nextIdx = currentIdx + direction;
		if (nextIdx >= 0 && nextIdx < files.length) {
			setActiveFilePath(files[nextIdx]!.path);
		}
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

		const panel = getActivePanel();

		// ── Space: toggle sidebar ↔ diff-scroll ───────────────────────────────
		if (e.key === ' ') {
			e.preventDefault();
			if (isInDiffMode()) {
				enterSidebarMode();
			} else {
				enterScrollMode();
			}
			return;
		}

		// ── h / t: always return to tree/sidebar from any diff mode ──────────
		if ((e.key === 'h' || e.key === 't') && panel !== 'sidebar') {
			e.preventDefault();
			enterSidebarMode();
			return;
		}

		// ── diff-visual ────────────────────────────────────────────────────────
		if (panel === 'diff-visual') {
			if (e.key === 'Escape') {
				e.preventDefault();
				enterSidebarMode();
				return;
			}
			if (e.key === 'v') {
				e.preventDefault();
				exitVisualMode();
				return;
			}
			if (e.key === 'j' || e.key === 'ArrowDown') {
				e.preventDefault();
				moveCursor(1);
				return;
			}
			if (e.key === 'k' || e.key === 'ArrowUp') {
				e.preventDefault();
				moveCursor(-1);
				return;
			}
			if (e.key === 'c') {
				e.preventDefault();
				const cursor = getCursorLineIndex();
				const anchor = getAnchorLineIndex() ?? cursor;
				const side = getCursorSide() ?? 'additions';
				const startLine = Math.min(anchor, cursor);
				const endLine = Math.max(anchor, cursor);
				openComment(startLine, endLine, side);
				return;
			}
			return;
		}

		// ── diff-line ──────────────────────────────────────────────────────────
		if (panel === 'diff-line') {
			if (e.key === 'Escape') {
				e.preventDefault();
				enterSidebarMode();
				return;
			}
			if (e.key === 'v') {
				e.preventDefault();
				enterVisualMode();
				return;
			}
			if (e.key === 'j' || e.key === 'ArrowDown') {
				e.preventDefault();
				moveCursor(1);
				return;
			}
			if (e.key === 'k' || e.key === 'ArrowUp') {
				e.preventDefault();
				moveCursor(-1);
				return;
			}
			if (e.key === 'd') {
				e.preventDefault();
				jumpCursor('half-down');
				return;
			}
			if (e.key === 'u') {
				e.preventDefault();
				jumpCursor('half-up');
				return;
			}
			if (e.key === 'G') {
				e.preventDefault();
				pendingG = false;
				if (gTimer !== undefined) clearTimeout(gTimer);
				jumpCursor('bottom');
				return;
			}
			if (e.key === 'g' && !e.shiftKey) {
				if (pendingG) {
					e.preventDefault();
					pendingG = false;
					if (gTimer !== undefined) clearTimeout(gTimer);
					jumpCursor('top');
					return;
				}
				pendingG = true;
				gTimer = setTimeout(() => { pendingG = false; }, 300);
				e.preventDefault();
				return;
			}
			if (e.key === 'c') {
				e.preventDefault();
				const lineIdx = getCursorLineIndex();
				const side = getCursorSide() ?? 'additions';
				openComment(lineIdx, lineIdx, side);
				return;
			}
			if (pendingG) {
				pendingG = false;
				if (gTimer !== undefined) clearTimeout(gTimer);
			}
			return;
		}

		// ── diff-scroll ────────────────────────────────────────────────────────
		if (panel === 'diff-scroll') {
			if (e.key === 'Escape') {
				e.preventDefault();
				enterSidebarMode();
				return;
			}
			if (e.key === 'v') {
				e.preventDefault();
				enterLineMode(getTotalLineCount());
				return;
			}
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
			if (e.key === 'G') {
				e.preventDefault();
				pendingG = false;
				if (gTimer !== undefined) clearTimeout(gTimer);
				const el = getDiffScroll();
				if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
				return;
			}
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
				gTimer = setTimeout(() => { pendingG = false; }, 300);
				e.preventDefault();
				return;
			}
			if (pendingG) {
				pendingG = false;
				if (gTimer !== undefined) clearTimeout(gTimer);
			}
			return;
		}

		// ── sidebar (shared bindings) ──────────────────────────────────────────
		if (e.key === 'v') {
			e.preventDefault();
			enterLineMode(getTotalLineCount());
			return;
		}
		if (e.key === 'n') {
			e.preventDefault();
			navigateFile(1);
		} else if (e.key === 'p') {
			e.preventDefault();
			navigateFile(-1);
		}
	}

	// ── Mode indicator derived state ─────────────────────────────────────────
	const panel = $derived(getActivePanel());
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="relative flex h-full flex-col overflow-hidden bg-diff-bg">
	<!-- @pierre/diffs renderer -->
	<div
		class="diff-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none"
		class:mode-scroll={panel === 'diff-scroll'}
		class:mode-line={panel === 'diff-line'}
		class:mode-visual={panel === 'diff-visual'}
		tabindex="-1"
		role="presentation"
	>
		{#if activeFile}
			<div class="file-title-section" bind:this={fileTitleSectionEl}>
				<h1 class="file-title">{activeFileName}</h1>
			</div>
			<FileIssues filePath={activeFile.path} />
		{/if}
		<DiffViewer
			file={activeFile}
			{themeType}
			onModeChange={(m) => setDiffMode(m)}
			commentTrigger={pendingCommentTrigger}
		/>
	</div>

</div>

<style>
	.file-title-section {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 76px 32px 16px;
		flex-shrink: 0;
	}

	.file-title {
		font-size: 32px;
		font-weight: 700;
		color: var(--color-text-primary);
		line-height: 1.2;
		letter-spacing: -0.02em;
		margin: 0;
		font-family: var(--font-mono, monospace);
		word-break: break-all;
	}
</style>

