// What the review page shows for each PR — the tab, the open file and each
// pane's scroll — so switching PRs and coming back lands where the user was.

import { jsonCodec, readStored, STORAGE_KEYS, writeStored } from "$lib/stores/persisted.svelte";

/** The review page's tabs, in the order the tab bar shows them (and ⌘1–3 picks them). */
export const REVIEW_TABS = ["conversation", "walkthrough", "diff"] as const;
export type ReviewTab = (typeof REVIEW_TABS)[number];
type ScrollPaneKey = "walkthrough" | "diff" | "conversation" | "sidebar";

interface PrViewState {
  activeTab: ReviewTab;
  activeFilePath: string | null;
  scroll: Partial<Record<ScrollPaneKey, number>>;
}

const FIRST_VISIT_TAB: ReviewTab = "conversation";

function emptyState(): PrViewState {
  return { activeTab: FIRST_VISIT_TAB, activeFilePath: null, scroll: {} };
}

// The tab each PR was last left on survives an app restart, so "first
// visit" means first ever, not first since launch. Capped so the record of
// long-closed PRs can't grow forever; oldest visits drop first.
const LAST_TAB_CAP = 300;
const lastTabCodec = jsonCodec((v) =>
  v && typeof v === "object" ? (v as Record<string, string>) : undefined,
);

function rememberLastTab(prId: string, tab: ReviewTab): void {
  const tabs = { ...readStored(STORAGE_KEYS.prLastTab, lastTabCodec, {}) };
  delete tabs[prId];
  tabs[prId] = tab;
  const ids = Object.keys(tabs);
  for (const id of ids.slice(0, Math.max(0, ids.length - LAST_TAB_CAP))) delete tabs[id];
  writeStored(STORAGE_KEYS.prLastTab, lastTabCodec, tabs);
}

function lastTabFor(prId: string): ReviewTab | null {
  const tab = readStored(STORAGE_KEYS.prLastTab, lastTabCodec, {})[prId];
  return REVIEW_TABS.find((known) => known === tab) ?? null;
}

const store = $state({
  entries: new Map<string, PrViewState>(),
  activePrId: null as string | null,
});

function getOrCreate(prId: string): PrViewState {
  let s = store.entries.get(prId);
  if (!s) {
    s = emptyState();
    store.entries.set(prId, s);
    store.entries = new Map(store.entries);
  }
  return s;
}

export function getActiveTab(): ReviewTab {
  if (store.activePrId === null) return FIRST_VISIT_TAB;
  return store.entries.get(store.activePrId)?.activeTab ?? FIRST_VISIT_TAB;
}

export function setActiveTab(tab: ReviewTab): void {
  if (tab === getActiveTab() || store.activePrId === null) return;
  getOrCreate(store.activePrId).activeTab = tab;
  store.entries = new Map(store.entries);
  rememberLastTab(store.activePrId, tab);
}

export function getActiveFilePath(): string | null {
  if (store.activePrId === null) return null;
  return store.entries.get(store.activePrId)?.activeFilePath ?? null;
}

export function setActiveFilePath(path: string | null): void {
  if (store.activePrId !== null) {
    getOrCreate(store.activePrId).activeFilePath = path;
    store.entries = new Map(store.entries);
  }
}

export function switchPrViewState(prId: string): void {
  const tab = store.entries.get(prId)?.activeTab ?? lastTabFor(prId) ?? FIRST_VISIT_TAB;
  store.activePrId = prId;
  getOrCreate(prId).activeTab = tab;
  store.entries = new Map(store.entries);
  rememberLastTab(prId, tab);
}

export function getPrScrollPosition(prId: string, key: ScrollPaneKey): number {
  return store.entries.get(prId)?.scroll[key] ?? 0;
}

export function setPrScrollPosition(prId: string, key: ScrollPaneKey, value: number): void {
  getOrCreate(prId).scroll[key] = value;
  store.entries = new Map(store.entries);
}

export function reset(): void {
  store.entries = new Map();
  store.activePrId = null;
}
