/**
 * Format an ISO timestamp as a short relative-time string suitable for
 * comment headers ("just now", "5m ago", "3h ago", "2d ago"). Rolls over
 * to an ISO date once the delta exceeds 10 days.
 */
export function formatRelativeTime(iso: string): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return iso;
	const delta = Date.now() - then;
	const sec = Math.round(delta / 1000);
	if (sec < 45) return 'just now';
	const min = Math.round(sec / 60);
	if (min < 45) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 22) return `${hr}h ago`;
	const day = Math.round(hr / 24);
	if (day < 10) return `${day}d ago`;
	return new Date(then).toISOString().slice(0, 10);
}
