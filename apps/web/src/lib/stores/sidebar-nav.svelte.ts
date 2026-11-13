// Vim-like PR-list navigation. The cursor walks the PR rows the list renders
// for the selected repo, in order: open PRs, then closed ones while that
// section is open. The sidebar binds the keys (`layout/Sidebar.svelte`).

import { getOpenPrsByRepoOrdered } from "./pr-filters.svelte";
import { getArchivedByRepo } from "./prs.svelte";
import { getSelectedPrId, getSelectedRepo, selectPr } from "./route.svelte";
import { isArchiveOpen, setSidebarView } from "./sidebar.svelte";

let focusedId = $state<string | null>(null);

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
}

export function isFocusedVisible(): boolean {
  return focusedId !== null && rows.includes(focusedId);
}

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

export function focusLast(): void {
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
