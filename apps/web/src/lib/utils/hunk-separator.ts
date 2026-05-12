import type { HunkData } from '@pierre/diffs';

/**
 * Renders an expandable hunk separator. The library's InteractionManager
 * walks the click target's composed path looking for elements tagged with
 * `data-expand-button` / `data-expand-up` / `data-expand-down` /
 * `data-expand-all-button` and reads the hunk index from an ancestor's
 * `data-expand-index`, then calls the configured `onHunkExpand` (which the
 * library wires up automatically when `hunkSeparators` is a function).
 *
 * Shift+click on any expand button expands the full unchanged region.
 */
export function renderHunkSeparator(hunk: HunkData): DocumentFragment {
	const frag = document.createDocumentFragment();
	const row = document.createElement('div');
	row.dataset.hunkSeparator = '';
	row.dataset.expandIndex = String(hunk.hunkIndex);

	const exp = hunk.expandable;
	if (!exp) {
		// No unchanged region between hunks — render a plain divider.
		row.dataset.hunkSeparatorVariant = 'plain';
		frag.appendChild(row);
		return frag;
	}

	row.dataset.hunkSeparatorVariant = 'expandable';

	const upBtn = makeBtn({
		direction: 'up',
		label: 'Show 20 lines above',
		visible: exp.up,
		svg: '<polyline points="4 10 8 6 12 10"/>',
	});

	const allBtn = document.createElement('button');
	allBtn.type = 'button';
	allBtn.dataset.expandButton = '';
	allBtn.dataset.expandAllButton = '';
	allBtn.dataset.hunkSeparatorBtn = 'all';
	allBtn.setAttribute('aria-label', 'Expand all unchanged lines');
	allBtn.title = exp.chunked
		? 'Expand all unchanged lines (or shift-click an arrow)'
		: 'Expand unchanged region';
	allBtn.textContent = 'Expand all';

	const downBtn = makeBtn({
		direction: 'down',
		label: 'Show 20 lines below',
		visible: exp.down,
		svg: '<polyline points="4 6 8 10 12 6"/>',
	});

	row.appendChild(upBtn);
	row.appendChild(allBtn);
	row.appendChild(downBtn);
	frag.appendChild(row);
	return frag;
}

function makeBtn(opts: {
	direction: 'up' | 'down';
	label: string;
	visible: boolean;
	svg: string;
}): HTMLButtonElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.dataset.expandButton = '';
	if (opts.direction === 'up') btn.dataset.expandUp = '';
	else btn.dataset.expandDown = '';
	btn.dataset.hunkSeparatorBtn = opts.direction;
	btn.setAttribute('aria-label', opts.label);
	btn.title = opts.label;
	btn.innerHTML =
		`<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${opts.svg}</svg>`;
	if (!opts.visible) {
		btn.style.visibility = 'hidden';
		btn.tabIndex = -1;
	}
	return btn;
}

/**
 * Shared CSS for the hunk-separator markup produced by `renderHunkSeparator`.
 * Injected via `unsafeCSS` so it lives inside the diff's shadow root.
 */
export const HUNK_SEPARATOR_CSS = `
[data-hunk-separator] {
	display: flex;
	align-items: stretch;
	width: 100%;
	height: 22px;
	background: var(--diffs-color-surface, #1a1a1f);
	border-top: 1px solid var(--diffs-color-border, #2a2a32);
	border-bottom: 1px solid var(--diffs-color-border, #2a2a32);
	box-sizing: border-box;
	user-select: none;
}
[data-hunk-separator][data-hunk-separator-variant='plain'] {
	height: 2px;
	border: 0;
	background: var(--diffs-color-border, #2a2a32);
}
[data-hunk-separator] button {
	flex: 0 0 auto;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	padding: 0 8px;
	background: transparent;
	border: 0;
	border-right: 1px solid var(--diffs-color-border, #2a2a32);
	color: var(--diffs-color-muted, #8b8b94);
	font: inherit;
	font-size: 11px;
	cursor: pointer;
	transition: background-color 120ms, color 120ms;
}
[data-hunk-separator] button:last-child {
	border-right: 0;
}
[data-hunk-separator] button[data-hunk-separator-btn='all'] {
	flex: 1 1 auto;
	justify-content: center;
	letter-spacing: 0.02em;
}
[data-hunk-separator] button:hover {
	background: var(--diffs-color-surface-hover, rgba(255, 255, 255, 0.04));
	color: var(--diffs-color-fg, #e0e0e6);
}
[data-hunk-separator] button:focus-visible {
	outline: 1px solid var(--diffs-color-accent, #6da3ff);
	outline-offset: -1px;
}
`;
