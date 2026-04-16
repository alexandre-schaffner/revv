const SIDEBAR_WIDTH_KEY = 'rev:sidebar-width';
const SIDEBAR_WIDTH_DEFAULT = 280;
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 480;

function clampWidth(w: number): number {
	return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, w));
}

function loadPersistedWidth(): number {
	if (typeof localStorage === 'undefined') return SIDEBAR_WIDTH_DEFAULT;
	const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
	if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
	const parsed = parseInt(raw, 10);
	if (isNaN(parsed)) return SIDEBAR_WIDTH_DEFAULT;
	return clampWidth(parsed);
}

let sidebarCollapsed = $state(false);
let rightPanelOpen = $state(false);
let addRepoDialogOpen = $state(false);
let collapseAllSignal = $state(0);
let sidebarWidth = $state(loadPersistedWidth());

$effect.root(() => {
	$effect(() => {
		localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
	});
});

// ── Sidebar ──────────────────────────────────────────────

export { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX };

export function getSidebarCollapsed(): boolean {
	return sidebarCollapsed;
}

export function setSidebarCollapsed(v: boolean): void {
	sidebarCollapsed = v;
}

export function toggleSidebar(): void {
	sidebarCollapsed = !sidebarCollapsed;
}

// ── Sidebar width ────────────────────────────────────────

export function getSidebarWidth(): number {
	return sidebarWidth;
}

export function setSidebarWidth(w: number): void {
	sidebarWidth = clampWidth(w);
}

export function resetSidebarWidth(): void {
	sidebarWidth = SIDEBAR_WIDTH_DEFAULT;
}

// ── Right panel ──────────────────────────────────────────

export function getRightPanelOpen(): boolean {
	return rightPanelOpen;
}

export function setRightPanelOpen(v: boolean): void {
	rightPanelOpen = v;
}

export function toggleRightPanel(): void {
	rightPanelOpen = !rightPanelOpen;
}

// ── Add-repo dialog ─────────────────────────────────────

export function getAddRepoDialogOpen(): boolean {
	return addRepoDialogOpen;
}

export function setAddRepoDialogOpen(v: boolean): void {
	addRepoDialogOpen = v;
}

export function openAddRepoDialog(): void {
	addRepoDialogOpen = true;
}

// ── Collapse-all signal ──────────────────────────────────
// A monotonically incrementing counter. RepoGroup components
// watch this in a $effect and collapse when it changes.

export function getCollapseAllSignal(): number {
	return collapseAllSignal;
}

export function collapseAllRepoGroups(): void {
	collapseAllSignal++;
}
