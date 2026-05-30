import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Entry } from "@napi-rs/keyring";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { account } from "../db/schema";
import { logError } from "../logger";
import { appDataDir, keyringServiceName } from "../paths";
import { DbService } from "./Db";

/**
 * GitHub OAuth tokens for a single linked account. Both rotate together, so
 * they are stored as one keyring entry (a JSON blob).
 */
export interface TokenPair {
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
}

/**
 * Secure store for GitHub OAuth token bytes.
 *
 * The OS secure element (macOS Keychain / Windows Credential Manager / Linux
 * Secret Service, via `@napi-rs/keyring`) is the authoritative home for the
 * token material — the `account` row keeps everything non-secret (which
 * accounts exist, provider/host, expiries, `reauthRequiredAt`, login/avatar).
 *
 * When the OS keyring is unavailable (e.g. a Linux session with no Secret
 * Service daemon), the store degrades to an AES-256-GCM encrypted file under
 * the app data dir. This is a fallback to avoid a hard failure, not the
 * intended path; it is logged loudly on entry.
 *
 * The fallback encryption key is *derived* (scrypt) from a secret plus a
 * persisted random salt, rather than read verbatim from a key file sitting
 * next to the ciphertext. When `BETTER_AUTH_SECRET` is configured in the
 * environment (the recommended deployment path), that secret never lands on
 * disk, so an attacker with only filesystem read of the app-support dir holds
 * the ciphertext and a useless salt — not the key. Absent an env secret we
 * fall back to a persisted `0600` key file, matching the trust model the
 * better-auth signing secret already uses (`auth.ts`).
 */
export class SecretStore extends Context.Tag("SecretStore")<
  SecretStore,
  {
    readonly setTokens: (accountId: string, tokens: TokenPair) => Effect.Effect<void>;
    readonly getTokens: (accountId: string) => Effect.Effect<TokenPair | null>;
    readonly deleteTokens: (accountId: string) => Effect.Effect<void>;
  }
>() {}

const KEYRING_USER_PREFIX = "github-tokens:";

function entryFor(accountId: string): Entry {
  return new Entry(keyringServiceName(), `${KEYRING_USER_PREFIX}${accountId}`);
}

function serialize(tokens: TokenPair): string {
  return JSON.stringify({
    accessToken: tokens.accessToken ?? null,
    refreshToken: tokens.refreshToken ?? null,
  });
}

function deserialize(raw: string): TokenPair {
  try {
    const o = JSON.parse(raw) as Partial<TokenPair>;
    return { accessToken: o.accessToken ?? null, refreshToken: o.refreshToken ?? null };
  } catch {
    // Tolerate a legacy raw-string access token (defensive — current writes
    // always JSON-encode).
    return { accessToken: raw, refreshToken: null };
  }
}

// ── Encrypted-file fallback ────────────────────────────────────────────────

function fallbackKeyPath(): string {
  return join(appDataDir(), "secret-store.key");
}
function fallbackSaltPath(): string {
  return join(appDataDir(), "secret-store.salt");
}
function fallbackDataPath(): string {
  return join(appDataDir(), "secret-store.enc");
}

function ensureAppDir(): void {
  const dir = appDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Load (or generate) the non-secret random salt persisted beside the data. */
function loadFallbackSalt(): Buffer {
  const p = fallbackSaltPath();
  if (existsSync(p)) {
    const hex = readFileSync(p, "utf8").trim();
    if (hex.length >= 32) return Buffer.from(hex.slice(0, 32), "hex");
  }
  ensureAppDir();
  const salt = randomBytes(16);
  writeFileSync(p, salt.toString("hex"), { mode: 0o600 });
  return salt;
}

/**
 * Resolve the input secret for key derivation. Prefers `BETTER_AUTH_SECRET`
 * from the environment (kept off disk); otherwise falls back to a persisted
 * `0600` random key file, generated on first use.
 */
function loadFallbackSecret(): string {
  const envSecret = process.env.BETTER_AUTH_SECRET;
  if (envSecret && envSecret.length > 0) return envSecret;

  const p = fallbackKeyPath();
  if (existsSync(p)) {
    const existing = readFileSync(p, "utf8").trim();
    if (existing.length > 0) return existing;
  }
  ensureAppDir();
  const secret = randomBytes(32).toString("hex");
  writeFileSync(p, secret, { mode: 0o600 });
  return secret;
}

/** Derive the AES-256 key from the resolved secret + persisted salt (scrypt). */
function deriveFallbackKey(): Buffer {
  return scryptSync(loadFallbackSecret(), loadFallbackSalt(), 32);
}

function readFallbackMap(): Record<string, TokenPair> {
  try {
    if (!existsSync(fallbackDataPath())) return {};
    const raw = readFileSync(fallbackDataPath());
    // Layout: iv(12) | authTag(16) | ciphertext
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", deriveFallbackKey(), iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    return JSON.parse(json) as Record<string, TokenPair>;
  } catch (e) {
    logError("SecretStore", "fallback store read failed:", e);
    return {};
  }
}

function writeFallbackMap(map: Record<string, TokenPair>): void {
  ensureAppDir();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveFallbackKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(map), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(fallbackDataPath(), Buffer.concat([iv, tag, ct]), { mode: 0o600 });
}

export const SecretStoreLive = Layer.sync(SecretStore, () => {
  // Probe once: getPassword returns null when the entry is absent and throws
  // only when the backend itself is unreachable, so it's a clean availability
  // check. All ops route consistently to keyring or fallback to avoid a
  // split-brain where a token lands in one store and is read from the other.
  let useKeyring = true;
  try {
    new Entry(keyringServiceName(), "__revv_probe__").getPassword();
  } catch (e) {
    useKeyring = false;
    logError(
      "SecretStore",
      "OS keyring unavailable — falling back to encrypted-file token store:",
      e,
    );
  }

  return {
    setTokens: (accountId, tokens) =>
      Effect.sync(() => {
        const json = serialize(tokens);
        if (useKeyring) {
          try {
            entryFor(accountId).setPassword(json);
            return;
          } catch (e) {
            logError("SecretStore", `keyring set failed for ${accountId}; using fallback:`, e);
          }
        }
        const map = readFallbackMap();
        map[accountId] = deserialize(json);
        writeFallbackMap(map);
      }),

    getTokens: (accountId) =>
      Effect.sync((): TokenPair | null => {
        if (useKeyring) {
          try {
            const v = entryFor(accountId).getPassword();
            if (v) return deserialize(v);
          } catch (e) {
            logError("SecretStore", `keyring get failed for ${accountId}; using fallback:`, e);
          }
        }
        const map = readFallbackMap();
        return map[accountId] ?? null;
      }),

    deleteTokens: (accountId) =>
      Effect.sync(() => {
        if (useKeyring) {
          try {
            entryFor(accountId).deletePassword();
          } catch {
            // No matching entry / backend hiccup — nothing to clean up.
          }
        }
        const map = readFallbackMap();
        if (accountId in map) {
          delete map[accountId];
          writeFallbackMap(map);
        }
      }),
  };
});

/**
 * One-time boot migration: copy any plaintext tokens still living in the
 * `account.access_token` / `refresh_token` columns into the secure store, then
 * null the columns. Idempotent — rows already migrated have null columns and
 * are skipped. Returns the number of accounts migrated.
 */
export const migrateLegacyTokens: Effect.Effect<number, never, SecretStore | DbService> =
  Effect.gen(function* () {
    const store = yield* SecretStore;
    const { db } = yield* DbService;
    const rows = db
      .select({
        id: account.id,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
      })
      .from(account)
      .all();
    let migrated = 0;
    for (const r of rows) {
      if (!r.accessToken && !r.refreshToken) continue;
      yield* store.setTokens(r.id, {
        accessToken: r.accessToken ?? null,
        refreshToken: r.refreshToken ?? null,
      });
      db.update(account)
        .set({ accessToken: null, refreshToken: null, updatedAt: new Date() })
        .where(eq(account.id, r.id))
        .run();
      migrated++;
    }
    return migrated;
  });
