// ── Vim-like PR-list navigation ─────────────────────────────
//
// The cursor walks the PR rows the list renders for the selected repo, in
// order: open PRs, then closed ones while that section is open.
//
// Bindings:
//   j / ArrowDown    Move down
//   k / ArrowUp      Move up
//   l / ArrowRight   Open the PR
//   h / ArrowLeft    Drop the cursor
//   Enter            Open the PR
//   gg               Jump to first row
//   G                Jump to last row
//   Escape           Drop the cursor

import {
  getArchivedByRepo,
  getOpenPrsByRepoOrdered,
  getSelectedPrId,
  getSelectedRepo,
  selectPr,
} from "./prs.svelte";
import { isArchiveOpen, setSidebarView } from "./sidebar.svelte";

let focusedId = $state<string | null>(null);
let pendingG = false;
let gTimer: ReturnType<typeof setTimeout> | undefined;

const rows = $derived.by((): string[] => {
  const repo = getSelectedRepo();
  if (!repo) return [];
  const open = getOpenPrsByRepoOrdered(repo.id).map((pr) => pr.id);
  if (!isArchiveOpen(repo.id)) return open;
  return [...open, ...(getArchivedByRepo().get(repo.id) ?? []).map((pr) => pr.id)];
});

export function getFocusedId(): string | null {
  return focusedId;
}

export function setFocusedId(id: string | null): void {
  focusedId = id;
}

export function clearFocus(): void {
  focusedId = null;
  pendingG = false;
}

/** Whether the cursor sits on a row that is on screen. */
export function isFocusedVisible(): boolean {
  return focusedId !== null && rows.includes(focusedId);
}

/** Open a PR: navigate to it (unless it is already open) and show its file tree. */
export function openPr(prId: string): void {
  if (getSelectedPrId() !== prId) void selectPr(prId);
  setSidebarView("files");
}

/** Put the cursor on the first row. False when the list is empty. */
export function focusFirst(): boolean {
  const first = rows[0];
  if (first === undefined) return false;
  focusedId = first;
  return true;
}

function focusLast(): void {
  const last = rows.at(-1);
  if (last !== undefined) focusedId = last;
}

export function moveDown(): void {
  const index = focusedId === null ? -1 : rows.indexOf(focusedId);
  if (index === -1) {
    focusFirst();
    return;
  }
  const next = rows[index + 1];
  if (next !== undefined) focusedId = next;
}

export function moveUp(): void {
  const index = focusedId === null ? -1 : rows.indexOf(focusedId);
  if (index === -1) {
    focusLast();
    return;
  }
  const prev = rows[index - 1];
  if (prev !== undefined) focusedId = prev;
}

export function openFocused(): void {
  if (focusedId !== null && rows.includes(focusedId)) openPr(focusedId);
}

/** Back from the file tree: the cursor lands on the PR that was open. */
export function focusPr(prId: string | null): void {
  if (prId !== null && rows.includes(prId)) focusedId = prId;
  else clearFocus();
}

/** Returns true if the key was consumed (caller should preventDefault). */
export function handleKey(e: KeyboardEvent): boolean {
  if (e.key === "g" && !e.shiftKey) {
    if (pendingG) {
      pendingG = false;
      if (gTimer !== undefined) clearTimeout(gTimer);
      focusFirst();
      return true;
    }
    pendingG = true;
    gTimer = setTimeout(() => {
      pendingG = false;
    }, 300);
    return true;
  }

  if (pendingG) {
    pendingG = false;
    if (gTimer !== undefined) clearTimeout(gTimer);
  }

  switch (e.key) {
    case "j":
    case "ArrowDown":
      moveDown();
      return true;
    case "k":
    case "ArrowUp":
      moveUp();
      return true;
    case "l":
    case "ArrowRight":
      openFocused();
      return true;
    case "h":
    case "ArrowLeft":
      clearFocus();
      return true;
    case "Enter":
      if (focusedId) {
        openFocused();
        return true;
      }
      return false;
    case "G":
      focusLast();
      return true;
    case "Escape":
      if (focusedId) {
        clearFocus();
        return true;
      }
      return false;
    default:
      return false;
  }
}
