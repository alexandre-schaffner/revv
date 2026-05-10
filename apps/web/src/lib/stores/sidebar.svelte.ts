const SIDEBAR_WIDTH_KEY = 'revv:sidebar-width';
const SIDEBAR_WIDTH_DEFAULT = 280;
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 480;

const RIGHT_PANEL_WIDTH_KEY = 'revv:right-panel-width';
const RIGHT_PANEL_WIDTH_DEFAULT = 340;
const RIGHT_PANEL_WIDTH_MIN = 280;
const RIGHT_PANEL_WIDTH_MAX = 720;

function clampWidth(w: number): number {
	return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, w));
}

function clampRightPanelWidth(w: number): number {
	return Math.max(RIGHT_PANEL_WIDTH_MIN, Math.min(RIGHT_PANEL_WIDTH_MAX, w));
}

function loadPersistedWidth(): number {
	if (typeof localStorage === 'undefined') return SIDEBAR_WIDTH_DEFAULT;
	const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
	if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
	const parsed = parseInt(raw, 10);
	if (isNaN(parsed)) return SIDEBAR_WIDTH_DEFAULT;
	return clampWidth(parsed);
}

function loadPersistedRightPanelWidth(): number {
	if (typeof localStorage === 'undefined') return RIGHT_PANEL_WIDTH_DEFAULT;
	const raw = localStorage.getItem(RIGHT_PANEL_WIDTH_KEY);
	if (raw === null) return RIGHT_PANEL_WIDTH_DEFAULT;
	const parsed = parseInt(raw, 10);
	if (isNaN(parsed)) return RIGHT_PANEL_WIDTH_DEFAULT;
	return clampRightPanelWidth(parsed);
}

let sidebarCollapsed = $state(false);
let rightPanelOpen = $state(false);
let addRepoDialogOpen = $state(false);
let collapseAllSignal = $state(0);
let sidebarWidth = $state(loadPersistedWidth());
let rightPanelWidth = $state(loadPersistedRightPanelWidth());

// Two-view drawer: 'prs' (the PR list) ⇄ 'files' (full repo tree at the
// selected PR's head SHA). Transient — not persisted across reloads. Resets to
// 'prs' when the URL leaves a /review/[prId] route (see +layout.svelte).
type SidebarView = 'prs' | 'files';
let sidebarView = $state<SidebarView>('prs');

// Files-mode search query. Drives `tree.setSearch(...)` on the Pierre file
// tree via a prop on <PierreFileTree>. Transient — cleared whenever we leave
// files view (see setSidebarView below) and on PR / scope switches inside
// SidebarFilesView. Empty string means "no filter".
let fileSearchQuery = $state<string>('');

$effect.root(() => {
	$effect(() => {
		localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
	});
	$effect(() => {
		localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(rightPanelWidth));
	});
});

// ── Sidebar ──────────────────────────────────────────────

export { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX };
export { RIGHT_PANEL_WIDTH_DEFAULT, RIGHT_PANEL_WIDTH_MIN, RIGHT_PANEL_WIDTH_MAX };

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

// ── Right panel width ───────────────────────────────────

export function getRightPanelWidth(): number {
	return rightPanelWidth;
}

export function setRightPanelWidth(w: number): void {
	rightPanelWidth = clampRightPanelWidth(w);
}

export function resetRightPanelWidth(): void {
	rightPanelWidth = RIGHT_PANEL_WIDTH_DEFAULT;
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

// ── Sidebar view (PR list ⇄ file tree) ──────────────────

export function getSidebarView(): SidebarView {
	return sidebarView;
}

export function setSidebarView(v: SidebarView): void {
	sidebarView = v;
	// Single chokepoint for clearing the files-mode search query when we
	// leave files view. Both the user-driven swipe-back paths
	// (Sidebar.handleKeydown's Esc/h, the breadcrumb back button) and the
	// route-driven auto-reset in +layout.svelte funnel through this setter,
	// so dropping the query here covers every exit.
	if (v === 'prs') {
		fileSearchQuery = '';
	}
}

// ── Files-mode search ───────────────────────────────────

export function getFileSearchQuery(): string {
	return fileSearchQuery;
}

export function setFileSearchQuery(v: string): void {
	fileSearchQuery = v;
}
