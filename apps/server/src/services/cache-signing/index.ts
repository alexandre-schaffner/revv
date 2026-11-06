import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Stream } from "effect";
import {
  SshKeysFetchFailed,
  SshSignatureInvalid,
  SshSigningUnavailable,
} from "../../domain/errors";
import { debug } from "../../logger";
import { githubTryPromise } from "../../observability/github-ledger/origin";
import { GitHubAccounts } from "../github/accounts";
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

export class SshSigner extends Context.Service<
  SshSigner,
  {
    /**
     * `accountId` is the account tracking the repository the message is about.
     * With no key path in settings, the first call picks the `~/.ssh` key that
     * account publishes on GitHub and saves it to settings.
     */
    readonly sign: (
      message: string,
      accountId: string,
    ) => Effect.Effect<SshSignResult, SshSigningUnavailable>;
    readonly verify: (
      message: string,
      signature: string,
      signerHost: string,
      signerLogin: string,
    ) => Effect.Effect<void, SshSignatureInvalid | SshKeysFetchFailed>;
  }
>()("SshSigner") {}

const SSH_KEY_PATTERNS = /^id_(ed25519|ecdsa|rsa)$/;

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
    } catch {}
  }

  return null;
}

export const SshSignerLive = Layer.effect(
  SshSigner,
  Effect.gen(function* () {
    const settingsSvc = yield* SettingsService;
    const accounts = yield* GitHubAccounts;
    const pubkeyCache = new PubkeyCache();

    yield* Effect.forkScoped(
      settingsSvc
        .settingsChanges()
        .pipe(Stream.runForEach(() => Effect.sync(() => pubkeyCache.invalidate()))),
    );

    return SshSigner.of({
      sign: (message, accountId) =>
        Effect.gen(function* () {
          const settings = yield* settingsSvc.getSettings();

          const profile = yield* accounts.profile(accountId).pipe(
            Effect.mapError(
              (e) =>
                new SshSigningUnavailable({
                  message: `account lookup failed: ${e._tag === "DbError" ? e.message : `account ${accountId} not found`}`,
                  cause: e,
                }),
            ),
          );
          const acct = profile.githubLogin
            ? { host: profile.host, login: profile.githubLogin, githubUserId: profile.githubUserId }
            : null;

          if (!acct) {
            return yield* Effect.fail(
              new SshSigningUnavailable({
                message:
                  "No GitHub account with a login found — sign in via Settings before enabling cache signing.",
              }),
            );
          }

          let keyPath = settings.cache.signing.keyPath;
          let autoDetected: string | undefined;

          if (!keyPath) {
            const detected = yield* githubTryPromise({
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
            autoDetected = detected;
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

          if (autoDetected) {
            yield* settingsSvc
              .updateSettings({ cache: { signing: { keyPath: autoDetected } } })
              .pipe(Effect.ignore);
            debug("cache-signing", `auto-detected key path: ${autoDetected}`);
          }

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
          const publicKeys = yield* githubTryPromise({
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
