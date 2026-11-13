// What the review page shows for each PR — the tab, the open file and each
// pane's scroll — so switching PRs and coming back lands where the user was.
// It also owns which PR's review is on screen: there is only ever one, so the
// tab and file accessors act on that one (conventions §4.1's exception).

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
  /** The one review on screen, opened by `useOpenReview`. */
  openPrId: null as string | null,
});

function stateOf(prId: string): PrViewState {
  return store.entries.get(prId) ?? emptyState();
}

function updateState(prId: string, update: (state: PrViewState) => PrViewState): void {
  const next = new Map(store.entries);
  next.set(prId, update(stateOf(prId)));
  store.entries = next;
}

export function getActiveTab(): ReviewTab {
  if (store.openPrId === null) return FIRST_VISIT_TAB;
  return store.entries.get(store.openPrId)?.activeTab ?? FIRST_VISIT_TAB;
}

export function setActiveTab(tab: ReviewTab): void {
  const prId = store.openPrId;
  if (prId === null || tab === getActiveTab()) return;
  updateState(prId, (state) => ({ ...state, activeTab: tab }));
  rememberLastTab(prId, tab);
}

export function getActiveFilePath(): string | null {
  if (store.openPrId === null) return null;
  return store.entries.get(store.openPrId)?.activeFilePath ?? null;
}

export function setActiveFilePath(path: string | null): void {
  const prId = store.openPrId;
  if (prId !== null) updateState(prId, (state) => ({ ...state, activeFilePath: path }));
}

/** Put `prId`'s review on screen, on the tab it was last left on. */
export function openPrView(prId: string): void {
  const tab = store.entries.get(prId)?.activeTab ?? lastTabFor(prId) ?? FIRST_VISIT_TAB;
  store.openPrId = prId;
  updateState(prId, (state) => ({ ...state, activeTab: tab }));
  rememberLastTab(prId, tab);
}

/** The review page for `prId` went away; a newer page may already have opened another. */
export function closePrView(prId: string): void {
  if (store.openPrId === prId) store.openPrId = null;
}

export function getPrScrollPosition(prId: string, key: ScrollPaneKey): number {
  return store.entries.get(prId)?.scroll[key] ?? 0;
}

export function setPrScrollPosition(prId: string, key: ScrollPaneKey, value: number): void {
  updateState(prId, (state) => ({ ...state, scroll: { ...state.scroll, [key]: value } }));
}

export function reset(): void {
  store.entries = new Map();
  store.openPrId = null;
}
