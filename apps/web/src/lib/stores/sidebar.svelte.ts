import {
  clampedIntCodec,
  flagCodec,
  jsonCodec,
  readStored,
  STORAGE_KEYS,
  writeStored,
} from "$lib/stores/persisted.svelte";

export const RAIL_WIDTH = 64;

const SIDEBAR_WIDTH_DEFAULT = 280;
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 480;

const RIGHT_PANEL_WIDTH_DEFAULT = 340;
const RIGHT_PANEL_WIDTH_MIN = 280;
const RIGHT_PANEL_WIDTH_MAX = 720;

/** Narrowest main pane we're willing to leave behind when the chat panel sits
    beside it. Below this the diff/walkthrough columns stop being readable, so
    the chat switches to the stacked presentation (covers the main pane, back
    button in its header) — the same trade Slack makes with thread view. */
const MAIN_MIN_WIDTH = 520;

function clampWidth(w: number): number {
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, w));
}

function clampRightPanelWidth(w: number): number {
  return Math.max(RIGHT_PANEL_WIDTH_MIN, Math.min(RIGHT_PANEL_WIDTH_MAX, w));
}

const sidebarWidthCodec = clampedIntCodec(SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX);
const rightPanelWidthCodec = clampedIntCodec(RIGHT_PANEL_WIDTH_MIN, RIGHT_PANEL_WIDTH_MAX);
const collapsedOwnersCodec = jsonCodec<string[]>((v) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined,
);

let sidebarCollapsed = $state(false);
let rightPanelOpen = $state(false);
let addRepoDialogOpen = $state(false);
let sidebarWidth = $state(
  readStored(STORAGE_KEYS.sidebarWidth, sidebarWidthCodec, SIDEBAR_WIDTH_DEFAULT),
);
let rightPanelWidth = $state(
  readStored(STORAGE_KEYS.rightPanelWidth, rightPanelWidthCodec, RIGHT_PANEL_WIDTH_DEFAULT),
);

// `ssr = false`, so touching `window` at module scope is safe.
let viewportWidth = $state(window.innerWidth);

let collapsedOwners = $state<Set<string>>(
  new Set(readStored(STORAGE_KEYS.railCollapsedOwners, collapsedOwnersCodec, [])),
);

// 'files' is the full repo tree at the selected PR's head SHA. Not persisted;
// +layout.svelte follows the route (files on /review/[prId], prs elsewhere).
type SidebarView = "prs" | "files";
let sidebarView = $state<SidebarView>("prs");

let fileSearchQuery = $state<string>("");

$effect.root(() => {
  $effect(() => {
    writeStored(STORAGE_KEYS.sidebarWidth, sidebarWidthCodec, sidebarWidth);
  });
  $effect(() => {
    writeStored(STORAGE_KEYS.rightPanelWidth, rightPanelWidthCodec, rightPanelWidth);
  });
  $effect(() => {
    writeStored(STORAGE_KEYS.railCollapsedOwners, collapsedOwnersCodec, [...collapsedOwners]);
  });
  $effect(() => {
    const onResize = (): void => {
      viewportWidth = window.innerWidth;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });
});

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

export function getSidebarWidth(): number {
  return sidebarWidth;
}

export function setSidebarWidth(w: number): void {
  sidebarWidth = clampWidth(w);
}

export function resetSidebarWidth(): void {
  sidebarWidth = SIDEBAR_WIDTH_DEFAULT;
}

export function getRightPanelOpen(): boolean {
  return rightPanelOpen;
}

export function setRightPanelOpen(v: boolean): void {
  rightPanelOpen = v;
}

export function toggleRightPanel(): void {
  rightPanelOpen = !rightPanelOpen;
}

function chromeWidth(): number {
  return RAIL_WIDTH + (sidebarCollapsed ? 0 : sidebarWidth);
}

/** True when the window is too narrow to show the chat beside the main pane.
    In that case the chat presents *over* the main pane with a back button in
    its header instead of alongside it. Purely a presentation switch —
    `rightPanelOpen` is unchanged, so growing the window restores the
    side-by-side layout with the conversation still open.

    Measured against the panel's *minimum* width, not the user's preferred
    one: a wide stored preference should make the panel give width back
    (see `getRightPanelWidth`), not collapse the layout into one pane. */
export function getChatStacked(): boolean {
  return viewportWidth - chromeWidth() - RIGHT_PANEL_WIDTH_MIN < MAIN_MIN_WIDTH;
}

/** Widest the panel may actually render: whatever still leaves a usable main
    pane. Floored at the panel's own minimum, which only binds while stacked
    (where the width is unused anyway). */
function rightPanelWidthCap(): number {
  return Math.max(RIGHT_PANEL_WIDTH_MIN, viewportWidth - chromeWidth() - MAIN_MIN_WIDTH);
}

/** The width the panel renders at — the stored preference, given back to the
    main pane when the window can't afford it. `rightPanelWidth` keeps the
    preference untouched, so re-widening the window restores it. */
export function getRightPanelWidth(): number {
  return Math.min(rightPanelWidth, rightPanelWidthCap());
}

export function setRightPanelWidth(w: number): void {
  // The same cap applies to the drag, so resizing can never tip the layout
  // into stacked mode mid-drag (which would yank the resize handle out from
  // under the captured pointer). Only a window resize crosses that line.
  rightPanelWidth = Math.min(clampRightPanelWidth(w), rightPanelWidthCap());
}

export function resetRightPanelWidth(): void {
  rightPanelWidth = RIGHT_PANEL_WIDTH_DEFAULT;
}

export function getAddRepoDialogOpen(): boolean {
  return addRepoDialogOpen;
}

export function setAddRepoDialogOpen(v: boolean): void {
  addRepoDialogOpen = v;
}

export function openAddRepoDialog(): void {
  addRepoDialogOpen = true;
}

export function getSidebarView(): SidebarView {
  return sidebarView;
}

export function setSidebarView(v: SidebarView): void {
  sidebarView = v;
  if (v === "prs") {
    fileSearchQuery = "";
  }
}

export function getFileSearchQuery(): string {
  return fileSearchQuery;
}

export function setFileSearchQuery(v: string): void {
  fileSearchQuery = v;
}

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

let archiveOpen = $state(new Map<string, boolean>());

export function isArchiveOpen(repoId: string): boolean {
  return archiveOpen.get(repoId) ?? readStored(STORAGE_KEYS.archiveOpen(repoId), flagCodec, false);
}

export function toggleArchiveOpen(repoId: string): void {
  const open = !isArchiveOpen(repoId);
  archiveOpen = new Map(archiveOpen).set(repoId, open);
  writeStored(STORAGE_KEYS.archiveOpen(repoId), flagCodec, open);
}
