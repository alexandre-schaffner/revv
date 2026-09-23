/**
 * TypeSafe System One (Jev) settings. One switch: on runs every Jev judgment
 * (sizing, risk tier, file ranking, issue checks and severity, artifact and
 * prose checks, continuation adjudication); off makes no requests at all.
 */
export interface JevSettings {
  enabled: boolean;
  /** Derived server-side from the keyring. Never accepted in a settings patch. */
  hasApiKey: boolean;
}

export const DEFAULT_JEV_SETTINGS: JevSettings = {
  enabled: false,
  hasApiKey: false,
};
