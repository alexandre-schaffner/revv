// ─── Walkthrough scroll-nav store ───────────────────────────────────────────
//
// Bridge between the page (which owns the scroll container) and the AppShell
// (which renders the floating Top / Rating / New-content buttons). The page
// registers the scroll element once on mount; AppShell calls the scroll
// actions and reads `userScrolledUp` without having to know which DOM node
// owns the scrollable area.

let scrollRoot: HTMLElement | null = null;
let detachListener: (() => void) | null = null;
let userScrolledUp = $state(false);
let scrollHeightWhenLeft = $state(0);
let currentScrollHeight = $state(0);

export function setScrollRoot(el: HTMLElement | null): void {
	if (detachListener) {
		detachListener();
		detachListener = null;
	}
	scrollRoot = el;
	if (!el) {
		userScrolledUp = false;
		scrollHeightWhenLeft = 0;
		currentScrollHeight = 0;
		return;
	}
	const onScroll = (): void => {
		currentScrollHeight = el.scrollHeight;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
		if (atBottom) {
			userScrolledUp = false;
			scrollHeightWhenLeft = 0;
		} else if (!userScrolledUp && el.scrollTop > 0) {
			scrollHeightWhenLeft = el.scrollHeight;
			userScrolledUp = true;
		}
	};
	el.addEventListener('scroll', onScroll);
	detachListener = () => el.removeEventListener('scroll', onScroll);
}

export function getUserScrolledUp(): boolean {
	return userScrolledUp;
}

export function getHasNewContentBelow(): boolean {
	return userScrolledUp && currentScrollHeight > scrollHeightWhenLeft;
}

export function scrollToTop(): void {
	scrollRoot?.scrollTo({ top: 0, behavior: 'smooth' });
}

export function scrollToBottom(): void {
	if (!scrollRoot) return;
	userScrolledUp = false;
	scrollHeightWhenLeft = 0;
	currentScrollHeight = 0;
	scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, behavior: 'smooth' });
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
