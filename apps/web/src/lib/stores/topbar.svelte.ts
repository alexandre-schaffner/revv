/** Optional subtitle shown in the topbar (e.g. the current filename in diff view). */
let subtitle = $state<string | null>(null);

export function getTopbarSubtitle(): string | null {
	return subtitle;
}

export function setTopbarSubtitle(v: string | null): void {
	subtitle = v;
}
