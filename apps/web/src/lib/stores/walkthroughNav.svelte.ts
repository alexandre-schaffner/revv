// ─── Walkthrough scroll-nav store ───────────────────────────────────────────
//
// Bridge between the page (which owns the scroll container) and the AppShell
// (which renders the floating Top / Rating buttons). The page registers the
// scroll element once on mount; AppShell calls the scroll actions without
// having to know which DOM node owns the scrollable area.

let scrollRoot: HTMLElement | null = null;

export function setScrollRoot(el: HTMLElement | null): void {
	scrollRoot = el;
}

export function scrollToTop(): void {
	scrollRoot?.scrollTo({ top: 0, behavior: 'smooth' });
}

// Mirror of `scrollToRating()` in GuidedWalkthrough.svelte (the 16-px
// breathing room above the anchor matches the in-component button so the
// floating-pill version lands at the same Y offset).
export function scrollToRatings(): void {
	if (!scrollRoot) return;
	const el = document.getElementById('walkthrough-rating');
	if (!el) return;
	const containerRect = scrollRoot.getBoundingClientRect();
	const elRect = el.getBoundingClientRect();
	const offset = elRect.top - containerRect.top + scrollRoot.scrollTop - 16;
	scrollRoot.scrollTo({ top: offset, behavior: 'smooth' });
}
