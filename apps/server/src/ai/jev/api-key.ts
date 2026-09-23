import { Effect } from "effect";
import { serverEnv } from "../../config";
import { JEV_API_KEY_SECRET, SecretStore } from "../../services/SecretStore";

/**
 * TypeSafe System One API key storage. Route modules can't import `SecretStore`
 * directly (Identity boundary in `scripts/check-import-boundaries.ts`); these
 * helpers are the settings routes' way in, since the key shares the keyring.
 */

/**
 * Resolves the key, keyring first. The keyring wins over `REVV_JEV_API_KEY` so a
 * stale env var can't shadow a key the user typed into Settings. Returns `null`,
 * never `""`, when neither source has one.
 */
export const resolveJevApiKey: Effect.Effect<string | null, never, SecretStore> = Effect.gen(
  function* () {
    const store = yield* SecretStore;
    const stored = yield* store.getSecret(JEV_API_KEY_SECRET);
    const trimmedStored = stored?.trim();
    if (trimmedStored) return trimmedStored;
    const fromEnv = serverEnv.jevApiKey.trim();
    return fromEnv.length > 0 ? fromEnv : null;
  },
);

/** Cheap presence check for the settings DTO's `jev.hasApiKey`. */
export const hasJevApiKey: Effect.Effect<boolean, never, SecretStore> = Effect.map(
  resolveJevApiKey,
  (key) => key !== null,
);

/**
 * Persists the key, or clears it when `value` is blank — never writes `""`,
 * so {@link resolveJevApiKey} never has to distinguish "empty" from "absent".
 * Returns whether a key is set afterwards.
 */
export const setJevApiKey = (value: string): Effect.Effect<boolean, never, SecretStore> =>
  Effect.gen(function* () {
    const store = yield* SecretStore;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      yield* store.deleteSecret(JEV_API_KEY_SECRET);
      return false;
    }
    yield* store.setSecret(JEV_API_KEY_SECRET, trimmed);
    return true;
  });

/** Removes the stored key. `REVV_JEV_API_KEY` is out of reach: it's the operator's to unset, and pretending to clear it would make the UI lie. */
export const clearJevApiKey: Effect.Effect<void, never, SecretStore> = Effect.flatMap(
  SecretStore,
  (store) => store.deleteSecret(JEV_API_KEY_SECRET),
);
