/** Whether the topbar should collapse to compact (icon-only) height. */
let collapsed = $state(false);

export function getTopbarCollapsed(): boolean {
	return collapsed;
}

export function setTopbarCollapsed(v: boolean): void {
	collapsed = v;
}

/** Optional subtitle shown in the topbar (e.g. the current filename in diff view). */
let subtitle = $state<string | null>(null);

export function getTopbarSubtitle(): string | null {
	return subtitle;
}

export function setTopbarSubtitle(v: string | null): void {
	subtitle = v;
}
