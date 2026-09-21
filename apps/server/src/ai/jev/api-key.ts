import { Effect } from "effect";
import { serverEnv } from "../../config";
import { JEV_API_KEY_SECRET, SecretStore } from "../../services/SecretStore";

/**
 * TypeSafe System One API key storage.
 *
 * Route modules are barred from importing `SecretStore` directly (the
 * Identity boundary in `scripts/check-import-boundaries.ts`, there to keep
 * GitHub token material behind one service). These helpers are the settings
 * routes' way in — the key is not GitHub credential material, but it lives in
 * the same keyring, so it gets the same "one module owns the access" shape.
 */

/**
 * Resolve the key, keyring first.
 *
 * The keyring wins over `REVV_JEV_API_KEY` deliberately: the env var is a dev
 * convenience baked into a shell profile or a LaunchAgent plist, while a key
 * the user typed into Settings is the one they expect to be in effect. A
 * stale env var must not silently shadow it.
 *
 * Returns `null` — never an empty string — when neither source has one, so
 * call sites can branch on nullishness alone.
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
 * Persist the key, or clear it when `value` is blank. An empty submission is
 * a clear rather than a write of `""` — otherwise {@link resolveJevApiKey}
 * would have to distinguish "present but empty" from "absent" everywhere.
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

/**
 * Remove the stored key. `REVV_JEV_API_KEY` is intentionally out of reach —
 * an env var is the operator's to unset, and silently pretending to have
 * cleared it would make the UI lie.
 */
export const clearJevApiKey: Effect.Effect<void, never, SecretStore> = Effect.flatMap(
  SecretStore,
  (store) => store.deleteSecret(JEV_API_KEY_SECRET),
);
