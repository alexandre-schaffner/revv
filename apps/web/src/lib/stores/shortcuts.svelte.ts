import { goto } from '$app/navigation';
import { toggleSidebar, toggleRightPanel } from './sidebar.svelte';
import { setActiveTab } from './review.svelte';

export type PaletteMode = 'search' | 'command';

let paletteOpen = $state(false);
let paletteMode = $state<PaletteMode>('search');

// ── Palette state ────────────────────────────────────────

export function getPaletteOpen(): boolean {
	return paletteOpen;
}

function setPaletteOpen(v: boolean): void {
	paletteOpen = v;
}

export function getPaletteMode(): PaletteMode {
	return paletteMode;
}

export function setPaletteMode(mode: PaletteMode): void {
	paletteMode = mode;
}

function openPalette(mode: PaletteMode): void {
	paletteMode = mode;
	paletteOpen = true;
}

export function closePalette(): void {
	paletteOpen = false;
}

// ── Global keydown listener ──────────────────────────────

function handleKeydown(e: KeyboardEvent): void {
	// Only handle meta-key combos globally (these should work even in inputs)
	if (!e.metaKey) return;

	// Cmd+Shift+P → command palette
	if (e.shiftKey && e.key.toLowerCase() === 'p') {
		e.preventDefault();
		e.stopPropagation();
		if (paletteOpen && paletteMode === 'command') {
			closePalette();
		} else {
			openPalette('command');
		}
		return;
	}

	// Cmd+P → PR search
	if (!e.shiftKey && e.key.toLowerCase() === 'p') {
		e.preventDefault();
		e.stopPropagation();
		if (paletteOpen && paletteMode === 'search') {
			closePalette();
		} else {
			openPalette('search');
		}
		return;
	}

	// Cmd+W → navigate to homepage
	if (!e.shiftKey && e.key.toLowerCase() === 'w') {
		e.preventDefault();
		e.stopPropagation();
		goto('/');
		return;
	}

	// Cmd+B → toggle sidebar
	if (!e.shiftKey && e.key.toLowerCase() === 'b') {
		e.preventDefault();
		e.stopPropagation();
		toggleSidebar();
		return;
	}

	// Cmd+S → toggle sidebar (same as Cmd+B)
	if (!e.shiftKey && e.key.toLowerCase() === 's') {
		e.preventDefault();
		e.stopPropagation();
		toggleSidebar();
		return;
	}

	// Cmd+R → toggle right panel
	if (!e.shiftKey && e.key.toLowerCase() === 'r') {
		e.preventDefault();
		e.stopPropagation();
		toggleRightPanel();
		return;
	}

	// Cmd+1 → Walkthrough tab
	if (e.key === '1') {
		e.preventDefault();
		e.stopPropagation();
		setActiveTab('walkthrough');
		return;
	}

	// Cmd+2 → Diff tab
	if (e.key === '2') {
		e.preventDefault();
		e.stopPropagation();
		setActiveTab('diff');
		return;
	}

	// Cmd+3 → Request Changes tab
	if (e.key === '3') {
		e.preventDefault();
		e.stopPropagation();
		setActiveTab('request-changes');
		return;
	}
}

/** Attach global keyboard listener. Returns cleanup function. */
export function initShortcuts(): () => void {
	window.addEventListener('keydown', handleKeydown, { capture: true });
	return () => window.removeEventListener('keydown', handleKeydown, { capture: true });
}
