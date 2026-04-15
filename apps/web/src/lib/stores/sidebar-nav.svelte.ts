// ── Vim-like sidebar navigation ─────────────────────────────
//
// Navigable items use `data-sidebar-nav` attributes on DOM elements.
// DOM order = visual order, so we query the DOM for item ordering.
//
// Bindings:
//   j / ArrowDown    Move focus down
//   k / ArrowUp      Move focus up
//   l / ArrowRight   Expand node or select leaf
//   h / ArrowLeft    Collapse node or jump to parent
//   Enter            Select / activate focused item
//   gg               Jump to first item
//   G                Jump to last item
//   /                Focus search input
//   Escape           Clear focus

let focusedId = $state<string | null>(null);
let pendingG = false;
let gTimer: ReturnType<typeof setTimeout> | undefined;

// ── Getters / Setters ───────────────────────────────────────

export function getFocusedId(): string | null {
	return focusedId;
}

export function setFocusedId(id: string | null): void {
	focusedId = id;
	if (id) {
		requestAnimationFrame(() => {
			const el = document.querySelector<HTMLElement>(
				`[data-sidebar-nav="${CSS.escape(id)}"]`,
			);
			el?.scrollIntoView({ block: 'nearest' });
		});
	}
}

export function clearFocus(): void {
	focusedId = null;
	pendingG = false;
}

// ── DOM helpers ─────────────────────────────────────────────

function getNavItems(): HTMLElement[] {
	return Array.from(
		document.querySelectorAll<HTMLElement>('[data-sidebar-nav]'),
	);
}

function getFocusedEl(): HTMLElement | null {
	if (!focusedId) return null;
	return document.querySelector<HTMLElement>(
		`[data-sidebar-nav="${CSS.escape(focusedId)}"]`,
	);
}

// ── Navigation actions ──────────────────────────────────────

export function moveDown(): void {
	const items = getNavItems();
	if (items.length === 0) return;

	if (focusedId === null) {
		const first = items[0]?.getAttribute('data-sidebar-nav');
		if (first) setFocusedId(first);
		return;
	}

	const idx = items.findIndex(
		(el) => el.getAttribute('data-sidebar-nav') === focusedId,
	);
	// If focused item no longer exists in DOM, restart from top
	if (idx === -1) {
		const first = items[0]?.getAttribute('data-sidebar-nav');
		if (first) setFocusedId(first);
		return;
	}

	const next = items[idx + 1];
	if (next) {
		const id = next.getAttribute('data-sidebar-nav');
		if (id) setFocusedId(id);
	}
}

export function moveUp(): void {
	const items = getNavItems();
	if (items.length === 0) return;

	if (focusedId === null) {
		const last = items[items.length - 1]?.getAttribute('data-sidebar-nav');
		if (last) setFocusedId(last);
		return;
	}

	const idx = items.findIndex(
		(el) => el.getAttribute('data-sidebar-nav') === focusedId,
	);
	// If focused item no longer exists in DOM, restart from bottom
	if (idx === -1) {
		const last = items[items.length - 1]?.getAttribute('data-sidebar-nav');
		if (last) setFocusedId(last);
		return;
	}

	const prev = items[idx - 1];
	if (prev) {
		const id = prev.getAttribute('data-sidebar-nav');
		if (id) setFocusedId(id);
	}
}

export function expandOrSelect(): void {
	const el = getFocusedEl();
	if (!el) return;

	const type = el.getAttribute('data-nav-type');
	const expanded = el.getAttribute('data-nav-expanded') === 'true';

	if ((type === 'repo' || type === 'dir' || type === 'pr') && !expanded) {
		el.click();
	} else if ((type === 'repo' || type === 'dir' || type === 'pr') && expanded) {
		moveDown();
	} else {
		// Leaf node (file) — activate
		el.click();
	}
}

export function collapseOrParent(): void {
	const el = getFocusedEl();
	if (!el) return;

	const type = el.getAttribute('data-nav-type');
	const expanded = el.getAttribute('data-nav-expanded') === 'true';

	if ((type === 'repo' || type === 'dir' || type === 'pr') && expanded) {
		el.click();
	} else {
		const parentId = el.getAttribute('data-nav-parent');
		if (parentId) setFocusedId(parentId);
	}
}

export function goToTop(): void {
	const items = getNavItems();
	const first = items[0]?.getAttribute('data-sidebar-nav');
	if (first) setFocusedId(first);
}

export function goToBottom(): void {
	const items = getNavItems();
	const last = items[items.length - 1]?.getAttribute('data-sidebar-nav');
	if (last) setFocusedId(last);
}

// ── Keyboard handler ────────────────────────────────────────
// Returns true if the key was consumed (caller should preventDefault).

export function handleKey(e: KeyboardEvent): boolean {
	// 'gg' sequence
	if (e.key === 'g' && !e.shiftKey) {
		if (pendingG) {
			pendingG = false;
			if (gTimer !== undefined) clearTimeout(gTimer);
			goToTop();
			return true;
		}
		pendingG = true;
		gTimer = setTimeout(() => {
			pendingG = false;
		}, 300);
		return true;
	}

	// Any other key cancels pending g
	if (pendingG) {
		pendingG = false;
		if (gTimer !== undefined) clearTimeout(gTimer);
	}

	switch (e.key) {
		case 'j':
		case 'ArrowDown':
			moveDown();
			return true;
		case 'k':
		case 'ArrowUp':
			moveUp();
			return true;
		case 'l':
		case 'ArrowRight':
			expandOrSelect();
			return true;
		case 'h':
		case 'ArrowLeft':
			collapseOrParent();
			return true;
		case 'Enter':
			if (focusedId) {
				expandOrSelect();
				return true;
			}
			return false;
		case 'G':
			goToBottom();
			return true;
		case 'Escape':
			if (focusedId) {
				clearFocus();
				return true;
			}
			return false;
		default:
			return false;
	}
}
