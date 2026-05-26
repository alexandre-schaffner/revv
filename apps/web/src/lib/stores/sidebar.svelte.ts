import { RAIL_WIDTH } from "$lib/constants";

const SIDEBAR_WIDTH_KEY = "revv:sidebar-width";
const SIDEBAR_WIDTH_DEFAULT = 280;
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 480;

const RIGHT_PANEL_WIDTH_KEY = "revv:right-panel-width";
const RIGHT_PANEL_WIDTH_DEFAULT = 340;
const RIGHT_PANEL_WIDTH_MIN = 280;
const RIGHT_PANEL_WIDTH_MAX = 720;

const RAIL_COLLAPSED_OWNERS_KEY = "revv:rail-collapsed-owners";

function clampWidth(w: number): number {
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, w));
}

function clampRightPanelWidth(w: number): number {
  return Math.max(RIGHT_PANEL_WIDTH_MIN, Math.min(RIGHT_PANEL_WIDTH_MAX, w));
}

function loadPersistedWidth(): number {
  if (typeof localStorage === "undefined") return SIDEBAR_WIDTH_DEFAULT;
  const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return SIDEBAR_WIDTH_DEFAULT;
  return clampWidth(parsed);
}

function loadPersistedRightPanelWidth(): number {
  if (typeof localStorage === "undefined") return RIGHT_PANEL_WIDTH_DEFAULT;
  const raw = localStorage.getItem(RIGHT_PANEL_WIDTH_KEY);
  if (raw === null) return RIGHT_PANEL_WIDTH_DEFAULT;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return RIGHT_PANEL_WIDTH_DEFAULT;
  return clampRightPanelWidth(parsed);
}

function loadCollapsedOwners(): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  const raw = localStorage.getItem(RAIL_COLLAPSED_OWNERS_KEY);
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

let sidebarCollapsed = $state(false);
let rightPanelOpen = $state(false);
let addRepoDialogOpen = $state(false);
let _collapseAllSignal = $state(0);
let sidebarWidth = $state(loadPersistedWidth());
let rightPanelWidth = $state(loadPersistedRightPanelWidth());

// Collapsed owner-folders in the project rail. Owners are stored
// lowercase. Default: every owner is expanded — owners only land here
// after the user explicitly collapses their folder. Persisted so the
// expand/collapse pattern survives reloads.
let collapsedOwners = $state<Set<string>>(loadCollapsedOwners());

// Transient "peek" state: true while the cursor is over a project avatar in
// the rail or anywhere inside the sidebar. Used to reveal the sidebar while
// `sidebarCollapsed` is true without changing the persistent toggle. A short
// close delay covers the gap when the cursor transits between the avatar
// and the sidebar, or between two avatars.
//
// `sidebarPeekRepoId` tracks which repo is currently being previewed — set
// by the avatar's mouseenter and held across transit into the sidebar so
// the panel shows that repo's PRs (not the URL-selected one) until the
// peek closes.
let sidebarPeekHovering = $state(false);
let sidebarPeekRepoId = $state<string | null>(null);
let peekCloseTimer: ReturnType<typeof setTimeout> | undefined;

// Two-view drawer: 'prs' (the PR list) ⇄ 'files' (full repo tree at the
// selected PR's head SHA). Transient — not persisted across reloads. Resets to
// 'prs' when the URL leaves a /review/[prId] route (see +layout.svelte).
type SidebarView = "prs" | "files";
let sidebarView = $state<SidebarView>("prs");

// Files-mode search query. Drives `tree.setSearch(...)` on the Pierre file
// tree via a prop on <PierreFileTree>. Transient — cleared whenever we leave
// files view (see setSidebarView below) and on PR / scope switches inside
// SidebarFilesView. Empty string means "no filter".
let fileSearchQuery = $state<string>("");

$effect.root(() => {
  $effect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  });
  $effect(() => {
    localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(rightPanelWidth));
  });
  $effect(() => {
    localStorage.setItem(RAIL_COLLAPSED_OWNERS_KEY, JSON.stringify([...collapsedOwners]));
  });
});

// ── Sidebar ──────────────────────────────────────────────

export {
  RIGHT_PANEL_WIDTH_DEFAULT,
  RIGHT_PANEL_WIDTH_MAX,
  RIGHT_PANEL_WIDTH_MIN,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
};

export function getSidebarCollapsed(): boolean {
  return sidebarCollapsed;
}

export function toggleSidebar(): void {
  sidebarCollapsed = !sidebarCollapsed;
}

// ── Sidebar peek (hover-to-reveal) ──────────────────────

export function getSidebarPeekHovering(): boolean {
  return sidebarPeekHovering;
}

export function setSidebarPeekHovering(v: boolean): void {
  if (peekCloseTimer !== undefined) {
    clearTimeout(peekCloseTimer);
    peekCloseTimer = undefined;
  }
  if (v) {
    sidebarPeekHovering = true;
  } else {
    peekCloseTimer = setTimeout(() => {
      sidebarPeekHovering = false;
      sidebarPeekRepoId = null;
      peekCloseTimer = undefined;
    }, 200);
  }
}

export function getSidebarPeekRepoId(): string | null {
  return sidebarPeekRepoId;
}

export function setSidebarPeekRepoId(id: string | null): void {
  sidebarPeekRepoId = id;
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

export function collapseAllRepoGroups(): void {
  _collapseAllSignal++;
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
  if (v === "prs") {
    fileSearchQuery = "";
  }
}

// ── Files-mode search ───────────────────────────────────

export function getFileSearchQuery(): string {
  return fileSearchQuery;
}

export function setFileSearchQuery(v: string): void {
  fileSearchQuery = v;
}

// ── Rail owner-folder collapse state ────────────────────

export function isOwnerCollapsed(owner: string): boolean {
  return collapsedOwners.has(owner.toLowerCase());
}

export function toggleOwnerCollapsed(owner: string): void {
  const key = owner.toLowerCase();
  const next = new Set(collapsedOwners);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedOwners = next;
}

// ── Main-area bounds for fixed-position floating chrome ───

/** Returns the left/right inset (in px) that fixed-position floating elements
    (e.g. pill tabs) should use to stay aligned with the visible main area.
    Mirrors the grid math in AppShell.svelte. */
export function getMainAreaBounds(): { left: number; right: number } {
  const effectiveCollapsed = sidebarCollapsed && !sidebarPeekHovering;
  return {
    left: RAIL_WIDTH + (effectiveCollapsed ? 0 : sidebarWidth),
    right: rightPanelOpen ? rightPanelWidth : 0,
  };
}

/** Inline `style=` string for a floating action bar pinned to the bottom of
    the visible main area. Sits above the BottomBar with one island of breathing
    room. Reads `getMainAreaBounds()` so it tracks sidebar/right-panel state. */
export function getActionsFloatStyle(): string {
  const bounds = getMainAreaBounds();
  return (
    `position: fixed; left: ${bounds.left}px; right: ${bounds.right}px; ` +
    `bottom: calc(var(--bottombar-height) + 2 * var(--spacing-island));`
  );
}
