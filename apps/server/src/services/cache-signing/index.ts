import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Stream } from "effect";
import type { Db } from "../../db/index";
import { account, user } from "../../db/schema";
import {
  SshKeysFetchFailed,
  SshSignatureInvalid,
  SshSigningUnavailable,
} from "../../domain/errors";
import { debug } from "../../logger";
import { DbService } from "../Db";
import { SettingsService } from "../Settings";
import { PubkeyCache } from "./pubkey-cache";
import { sshSign, sshVerify } from "./ssh-keygen";

export interface SshSignResult {
  signature: string;
  signerHost: string;
  signerLogin: string;
  signerGithubUserId: string;
  signatureNamespace: string;
}

// ── Context tag ───────────────────────────────────────────────────────────────

export class SshSigner extends Context.Tag("SshSigner")<
  SshSigner,
  {
    /**
     * Sign `message` with the local user's configured SSH key.
     * Auto-detects the key path on first call when settings leave it empty.
     * Fails with `SshSigningUnavailable` if no usable key is found.
     */
    readonly sign: (message: string) => Effect.Effect<SshSignResult, SshSigningUnavailable>;
    /**
     * Verify that `signature` was produced by `signerLogin` on `signerHost`
     * for exactly `message`.
     * Fails with `SshSignatureInvalid` or `SshKeysFetchFailed`.
     */
    readonly verify: (
      message: string,
      signature: string,
      signerHost: string,
      signerLogin: string,
    ) => Effect.Effect<void, SshSignatureInvalid | SshKeysFetchFailed>;
  }
>() {}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractHostFromProviderId(providerId: string): string {
  if (providerId.startsWith("github:")) return providerId.slice("github:".length);
  return "github.com";
}

const SSH_KEY_PATTERNS = /^id_(ed25519|ecdsa|rsa)$/;

function findAccountWithLoginSync(
  db: Db,
): { host: string; login: string; githubUserId: string; accessToken: string } | null {
  const firstUser = db.select({ id: user.id }).from(user).limit(1).get();
  if (!firstUser) return null;

  const rows = db
    .select({
      providerId: account.providerId,
      githubLogin: account.githubLogin,
      accountId: account.accountId,
      accessToken: account.accessToken,
    })
    .from(account)
    .where(eq(account.userId, firstUser.id))
    .all();

  for (const row of rows) {
    if (row.githubLogin && row.accessToken && row.accountId) {
      return {
        host: extractHostFromProviderId(row.providerId),
        login: row.githubLogin,
        githubUserId: row.accountId,
        accessToken: row.accessToken,
      };
    }
  }
  return null;
}

async function autoDetectKeyPath(
  login: string,
  host: string,
  pubkeyCache: PubkeyCache,
): Promise<string | null> {
  const sshDir = join(homedir(), ".ssh");
  let files: string[];
  try {
    files = await readdir(sshDir);
  } catch {
    return null;
  }

  const candidates = files.filter((f) => SSH_KEY_PATTERNS.test(f) && files.includes(`${f}.pub`));

  let publishedKeys: string[];
  try {
    publishedKeys = await pubkeyCache.getKeys(host, login);
  } catch {
    return null;
  }

  if (publishedKeys.length === 0) return null;

  for (const candidate of candidates) {
    const pubPath = join(sshDir, `${candidate}.pub`);
    try {
      const pubContent = (await readFile(pubPath, "utf8")).trim();
      if (publishedKeys.some((k) => k.trim() === pubContent)) {
        return join(sshDir, candidate);
      }
    } catch {
      // unreadable .pub — skip
    }
  }

  return null;
}

// ── Layer ─────────────────────────────────────────────────────────────────────

export const SshSignerLive = Layer.effect(
  SshSigner,
  Effect.gen(function* () {
    const settingsSvc = yield* SettingsService;
    const { db } = yield* DbService;
    const pubkeyCache = new PubkeyCache();

    // Invalidate pubkey cache whenever settings change (host set may change).
    yield* Effect.fork(
      settingsSvc
        .settingsChanges()
        .pipe(Stream.runForEach(() => Effect.sync(() => pubkeyCache.invalidate()))),
    );

    return SshSigner.of({
      sign: (message) =>
        Effect.gen(function* () {
          const settings = yield* settingsSvc
            .getSettings()
            .pipe(
              Effect.mapError(
                (e) => new SshSigningUnavailable({ message: `settings error: ${e.message}` }),
              ),
            );

          const acct = yield* Effect.try({
            try: () => findAccountWithLoginSync(db),
            catch: (e) =>
              new SshSigningUnavailable({
                message: `account lookup failed: ${e instanceof Error ? e.message : String(e)}`,
                cause: e,
              }),
          });

          if (!acct) {
            return yield* Effect.fail(
              new SshSigningUnavailable({
                message:
                  "No GitHub account with a login found — sign in via Settings before enabling cache signing.",
              }),
            );
          }

          let keyPath = settings.cache.signing.keyPath;

          if (!keyPath) {
            const detected = yield* Effect.tryPromise({
              try: () => autoDetectKeyPath(acct.login, acct.host, pubkeyCache),
              catch: () => new SshSigningUnavailable({ message: "key auto-detection failed" }),
            });

            if (!detected) {
              return yield* Effect.fail(
                new SshSigningUnavailable({
                  message: `No SSH key in ~/.ssh matches a key published on ${acct.host}/${acct.login}.keys — add one in Settings or set the key path manually.`,
                }),
              );
            }

            keyPath = detected;
            // Persist auto-detected path so future calls skip detection.
            yield* settingsSvc
              .updateSettings({ cache: { signing: { keyPath: detected } } })
              .pipe(Effect.ignore);
            debug("cache-signing", `auto-detected key path: ${detected}`);
          }

          const namespace = `revv-cache@${acct.host}`;
          const signature = yield* Effect.tryPromise({
            try: () => sshSign(message, keyPath, namespace),
            catch: (e) => {
              if (e instanceof SshSigningUnavailable) return e;
              return new SshSigningUnavailable({
                message: e instanceof Error ? e.message : String(e),
                cause: e,
              });
            },
          });

          return {
            signature,
            signerHost: acct.host,
            signerLogin: acct.login,
            signerGithubUserId: acct.githubUserId,
            signatureNamespace: namespace,
          };
        }),

      verify: (message, signature, signerHost, signerLogin) =>
        Effect.gen(function* () {
          const publicKeys = yield* Effect.tryPromise({
            try: () => pubkeyCache.getKeys(signerHost, signerLogin),
            catch: (e) => {
              if (e instanceof SshKeysFetchFailed) return e;
              return new SshKeysFetchFailed({ host: signerHost, login: signerLogin, cause: e });
            },
          });

          const namespace = `revv-cache@${signerHost}`;
          yield* Effect.tryPromise({
            try: () => sshVerify(message, signature, signerLogin, publicKeys, namespace),
            catch: (e) => {
              if (e instanceof SshSignatureInvalid) return e;
              if (e instanceof SshKeysFetchFailed) return e;
              return new SshSignatureInvalid({
                message: e instanceof Error ? e.message : String(e),
              });
            },
          });
        }),
    });
  }),
);
