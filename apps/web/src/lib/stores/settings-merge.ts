// ── Settings update merge ───────────────────────────────────────────────────
//
// Kept out of `settings.svelte.ts` so it can be tested: that module pulls in
// `$app/navigation` transitively, which doesn't resolve outside a SvelteKit
// build.

import type { UserSettings } from "@revv/shared";

/**
 * Shape accepted by `updateSettings`. Top-level fields are individually
 * optional. `recap`, `cache` and `jev` are recursively partial so callers can
 * patch a single nested field (e.g. `{ cache: { enabled: true } }`)
 * without spreading the whole sub-object. The server deep-merges them
 * against the current values.
 */
export type SettingsUpdate = Partial<Omit<UserSettings, "id" | "recap" | "cache" | "jev">> & {
  recap?: Partial<UserSettings["recap"]>;
  cache?: Partial<Omit<UserSettings["cache"], "signing">> & {
    signing?: Partial<UserSettings["cache"]["signing"]>;
  };
  /** `hasApiKey` is derived server-side from the keyring — not patchable. */
  jev?: Partial<Omit<UserSettings["jev"], "hasApiKey">>;
};

/**
 * Apply a `SettingsUpdate` onto a settings object the way the server will.
 *
 * Every nested object in `UserSettings` has to be listed here. A top-level
 * spread would replace the whole sub-object with the partial, so patching one
 * flag would read back as "every sibling flag is now false" until the next
 * full fetch — which looks exactly like the user having turned things off.
 *
 * `settings-merge.test.ts` walks a fixture and fails if any nested object
 * is missing from the list.
 */
export function mergeSettingsUpdate(current: UserSettings, partial: SettingsUpdate): UserSettings {
  return {
    ...current,
    ...partial,
    recap: partial.recap ? { ...current.recap, ...partial.recap } : current.recap,
    cache: partial.cache
      ? {
          ...current.cache,
          ...partial.cache,
          signing: partial.cache.signing
            ? { ...current.cache.signing, ...partial.cache.signing }
            : current.cache.signing,
        }
      : current.cache,
    // `hasApiKey` is server-derived and absent from `SettingsUpdate`, so the
    // spread can't clobber it — the current value carries through.
    jev: partial.jev ? { ...current.jev, ...partial.jev } : current.jev,
  } as UserSettings;
}
