// Client-local diff rendering preferences. Like the diff theme, these are
// per-machine display choices rather than account settings.

import { flagCodec, persisted, STORAGE_KEYS } from "$lib/stores/persisted.svelte";

const diffWrap = persisted(STORAGE_KEYS.diffWrap, flagCodec, false);

/** Whether long diff lines soft-wrap instead of scrolling horizontally. */
export function getDiffWrap(): boolean {
  return diffWrap.current;
}

export function setDiffWrap(wrap: boolean): void {
  diffWrap.current = wrap;
}
