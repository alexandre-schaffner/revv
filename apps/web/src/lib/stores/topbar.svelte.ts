/** Whether the topbar should collapse to compact (icon-only) height. */
let collapsed = $state(false);

export function getTopbarCollapsed(): boolean {
	return collapsed;
}

export function setTopbarCollapsed(v: boolean): void {
	collapsed = v;
}
