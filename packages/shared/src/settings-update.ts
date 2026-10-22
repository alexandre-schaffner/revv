import type { UserSettings } from "./types";

/** Patch accepted by both the settings client and server. */
export type SettingsUpdate = Partial<Omit<UserSettings, "id" | "recap" | "cache" | "jev">> & {
  recap?: Partial<UserSettings["recap"]>;
  cache?: Partial<Omit<UserSettings["cache"], "signing">> & {
    signing?: Partial<UserSettings["cache"]["signing"]>;
  };
  /** `hasApiKey` is derived server-side from the keyring. */
  jev?: Partial<Omit<UserSettings["jev"], "hasApiKey">>;
};

/** Apply a settings patch without replacing partially-updated nested objects. */
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
    jev: partial.jev ? { ...current.jev, ...partial.jev } : current.jev,
  };
}
