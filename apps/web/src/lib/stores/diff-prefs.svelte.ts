// How diffs render: line wrap is a client-local preference (per machine, like
// the diff theme); split vs unified is the account setting.

import { flagCodec, persisted, STORAGE_KEYS } from "$lib/stores/persisted.svelte";
import { getSettings, isSettingsLoaded, updateSettings } from "$lib/stores/settings.svelte";

const diffWrap = persisted(STORAGE_KEYS.diffWrap, flagCodec, false);

/** Whether long diff lines soft-wrap instead of scrolling horizontally. */
export function getDiffWrap(): boolean {
  return diffWrap.current;
}

export function setDiffWrap(wrap: boolean): void {
  diffWrap.current = wrap;
}

type DiffMode = "unified" | "split";

// Split vs unified is `settings.diffViewMode`, so the review toggle and the
// Settings default are one value. Until settings load there is nothing to
// merge an optimistic write into, so the choice is held here meanwhile.
let diffModeOverride = $state<DiffMode | null>(null);

export function getDiffMode(): DiffMode {
  return diffModeOverride ?? getSettings().diffViewMode;
}

export function setDiffMode(mode: DiffMode): void {
  diffModeOverride = isSettingsLoaded() ? null : mode;
  void updateSettings({ diffViewMode: mode });
}
