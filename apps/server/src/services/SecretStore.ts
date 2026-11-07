import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Entry, type EntryOptions } from "@napi-rs/keyring";
import { Context, Effect, Layer } from "effect";
import { serverEnv } from "../config";
import { logError } from "../logger";
import { appDataDir, keyringServiceName } from "../paths";

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
 * The macOS Keychain (via `@napi-rs/keyring`) is the authoritative home for the
 * token material — the `account` row keeps everything non-secret (which
 * accounts exist, provider/host, expiries, `reauthRequiredAt`, login/avatar).
 *
 * When the macOS Keychain is unavailable, the store degrades to an AES-256-GCM
 * encrypted file under the app data dir. This is a fallback to avoid a hard
 * failure, not the intended path; it is logged loudly on entry.
 *
 * The fallback encryption key is *derived* (scrypt) from a secret plus a
 * persisted random salt, rather than read verbatim from a key file sitting
 * next to the ciphertext. When `BETTER_AUTH_SECRET` is configured in the
 * environment, that secret never lands on disk, so an attacker with only
 * filesystem read of the app-support dir holds the ciphertext and a useless
 * salt — not the key. Absent an env secret we fall back to a persisted `0600`
 * key file.
 */
export class SecretStore extends Context.Service<
  SecretStore,
  {
    readonly setTokens: (accountId: string, tokens: TokenPair) => Effect.Effect<void>;
    readonly getTokens: (accountId: string) => Effect.Effect<TokenPair | null>;
    readonly deleteTokens: (accountId: string) => Effect.Effect<void>;
    /** Single-string secrets under a logical name, through the same keyring/fallback path as token pairs. */
    readonly setSecret: (key: string, value: string) => Effect.Effect<void>;
    readonly getSecret: (key: string) => Effect.Effect<string | null>;
    readonly deleteSecret: (key: string) => Effect.Effect<void>;
  }
>()("SecretStore") {}

const KEYRING_USER_PREFIX = "github-tokens:";
const KEYRING_SECRET_PREFIX = "secret:";

/**
 * On Linux, require the Secret Service. Without the pin the binding silently
 * falls back to the kernel keyring, which lives in memory and is wiped on
 * reboot; required, a missing Secret Service throws, the probe below fails,
 * and the encrypted-file store takes over, which persists. Ignored elsewhere.
 */
const ENTRY_OPTIONS: EntryOptions = { linux: { store: "secret-service" } };

function keyringEntry(username: string): Entry {
  return new Entry(keyringServiceName(), username, ENTRY_OPTIONS);
}

export function serialize(tokens: TokenPair): string {
  return JSON.stringify({
    accessToken: tokens.accessToken ?? null,
    refreshToken: tokens.refreshToken ?? null,
  });
}

export function deserialize(raw: string): TokenPair {
  try {
    const o = JSON.parse(raw) as Partial<TokenPair>;
    return { accessToken: o.accessToken ?? null, refreshToken: o.refreshToken ?? null };
  } catch {
    // A legacy raw-string access token; current writes always JSON-encode.
    return { accessToken: raw, refreshToken: null };
  }
}

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

function loadFallbackSecret(): string {
  if (serverEnv.secretStoreSecret) return serverEnv.secretStoreSecret;

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

function deriveFallbackKey(): Buffer {
  return scryptSync(loadFallbackSecret(), loadFallbackSalt(), 32);
}

type FallbackEntry = TokenPair | string;
type FallbackMap = Record<string, FallbackEntry>;

/**
 * The fallback file's contents. `unreadable` (it exists but won't decrypt or
 * parse — e.g. `BETTER_AUTH_SECRET` changed) is not the same as absent: the
 * file still holds every stored token, recoverable with the old secret.
 */
type FallbackRead =
  | { readonly kind: "ok"; readonly map: FallbackMap }
  | { readonly kind: "unreadable"; readonly cause: unknown };

function readFallbackFile(path = fallbackDataPath()): FallbackRead {
  if (!existsSync(path)) return { kind: "ok", map: {} };
  try {
    const raw = readFileSync(path);
    // Layout: iv(12) | authTag(16) | ciphertext
    if (raw.length < 28) throw new Error(`truncated (${raw.length} bytes)`);
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", deriveFallbackKey(), iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    return { kind: "ok", map: JSON.parse(json) as FallbackMap };
  } catch (cause) {
    return { kind: "unreadable", cause };
  }
}

/** For reads: an unreadable store answers nothing, loudly. */
function readFallbackMap(): FallbackMap {
  const read = readFallbackFile();
  if (read.kind === "ok") return read.map;
  logError("SecretStore", "fallback token store is unreadable; treating it as empty:", read.cause);
  return {};
}

/**
 * For writes. An unreadable store is moved aside, never overwritten: writing
 * the one new entry over it would erase every other stored token.
 */
export function fallbackMapForWrite(path = fallbackDataPath()): FallbackMap {
  const read = readFallbackFile(path);
  if (read.kind === "ok") return read.map;
  const aside = `${path}.unreadable-${Date.now()}`;
  renameSync(path, aside);
  logError(
    "SecretStore",
    `fallback token store is unreadable (was BETTER_AUTH_SECRET changed?); moved it to ${aside} and starting a new one:`,
    read.cause,
  );
  return {};
}

function writeFallbackMap(map: FallbackMap): void {
  ensureAppDir();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveFallbackKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(map), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(fallbackDataPath(), Buffer.concat([iv, tag, ct]), { mode: 0o600 });
}

interface Slot {
  readonly entry: Entry;
  readonly fallbackKey: string;
}

const tokenSlot = (accountId: string): Slot => ({
  entry: keyringEntry(`${KEYRING_USER_PREFIX}${accountId}`),
  fallbackKey: accountId,
});

const secretSlot = (key: string): Slot => ({
  entry: keyringEntry(`${KEYRING_SECRET_PREFIX}${key}`),
  fallbackKey: `${KEYRING_SECRET_PREFIX}${key}`,
});

export const SecretStoreLive = Layer.sync(SecretStore, () => {
  // Probe once: getPassword returns null when the entry is absent and throws
  // only when the backend itself is unreachable. All ops route consistently to
  // keyring or fallback to avoid a split-brain where a token lands in one store
  // and is read from the other.
  let useKeyring = true;
  try {
    keyringEntry("__revv_probe__").getPassword();
  } catch (e) {
    useKeyring = false;
    logError(
      "SecretStore",
      "OS keyring unavailable — falling back to encrypted-file token store:",
      e,
    );
  }

  const write = (slot: Slot, keyringValue: string, fallbackValue: FallbackEntry): void => {
    if (useKeyring) {
      try {
        slot.entry.setPassword(keyringValue);
        return;
      } catch (e) {
        logError("SecretStore", `keyring set failed for ${slot.fallbackKey}; using fallback:`, e);
      }
    }
    const map = fallbackMapForWrite();
    map[slot.fallbackKey] = fallbackValue;
    writeFallbackMap(map);
  };

  /** The keyring's string, else the fallback file's entry. */
  const read = (slot: Slot): FallbackEntry | undefined => {
    if (useKeyring) {
      try {
        const v = slot.entry.getPassword();
        if (v) return v;
      } catch (e) {
        logError("SecretStore", `keyring get failed for ${slot.fallbackKey}; using fallback:`, e);
      }
    }
    return readFallbackMap()[slot.fallbackKey];
  };

  const remove = (slot: Slot): void => {
    if (useKeyring) {
      try {
        slot.entry.deletePassword();
      } catch {
        // No matching entry / backend hiccup — nothing to clean up.
      }
    }
    const map = fallbackMapForWrite();
    if (slot.fallbackKey in map) {
      delete map[slot.fallbackKey];
      writeFallbackMap(map);
    }
  };

  return {
    setTokens: (accountId, tokens) =>
      Effect.sync(() => write(tokenSlot(accountId), serialize(tokens), tokens)),
    getTokens: (accountId) =>
      Effect.sync((): TokenPair | null => {
        const stored = read(tokenSlot(accountId));
        if (stored === undefined) return null;
        return typeof stored === "string" ? deserialize(stored) : stored;
      }),
    deleteTokens: (accountId) => Effect.sync(() => remove(tokenSlot(accountId))),
    setSecret: (key, value) => Effect.sync(() => write(secretSlot(key), value, value)),
    getSecret: (key) =>
      Effect.sync((): string | null => {
        const stored = read(secretSlot(key));
        return typeof stored === "string" && stored.length > 0 ? stored : null;
      }),
    deleteSecret: (key) => Effect.sync(() => remove(secretSlot(key))),
  };
});
