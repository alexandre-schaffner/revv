import { Context, Effect, Layer } from "effect";
import { auth } from "../auth";
import type { GitHubAuthError } from "../domain/errors";
import type { DbService } from "./Db";
import type { SecretStore, TokenPair } from "./SecretStore";
import { migrateLegacyTokens } from "./SecretStore";
import { TokenProvider } from "./TokenProvider";

type SessionResult = Awaited<ReturnType<typeof auth.api.getSession>>;

export type AuthSession = NonNullable<SessionResult>;

export interface AccountIdentity {
  readonly accountId: string;
  readonly accessToken: string;
  readonly providerId: string;
  readonly githubLogin: string | null;
  readonly host: string | null;
}

function hostFromProviderId(providerId: string): string | null {
  return providerId.split(":")[1] ?? null;
}

export class Identity extends Context.Tag("Identity")<
  Identity,
  {
    readonly sessionFromHeaders: (headers: Headers) => Promise<AuthSession | null>;
    readonly resolveAccount: (
      userId: string,
      host?: string,
    ) => Effect.Effect<AccountIdentity, GitHubAuthError>;
    readonly tokenForUser: (
      userId: string,
      host?: string,
    ) => Effect.Effect<string, GitHubAuthError>;
    readonly storeAccountTokens: (
      accountId: string,
      host: string,
      tokens: TokenPair,
    ) => Effect.Effect<void>;
    readonly clearReauthRequired: (accountId: string) => Effect.Effect<void>;
    readonly deleteAccountTokens: (accountId: string) => Effect.Effect<void>;
    readonly migrateLegacyTokenSecrets: Effect.Effect<number, never, SecretStore | DbService>;
  }
>() {}

export const IdentityLive = Layer.effect(
  Identity,
  TokenProvider.pipe(
    Effect.map((tokenProvider) => ({
      sessionFromHeaders: (headers: Headers) => auth.api.getSession({ headers }),
      resolveAccount: (userId: string, host?: string) =>
        tokenProvider.resolveAccount(userId, host).pipe(
          Effect.map((account) => ({
            ...account,
            host: hostFromProviderId(account.providerId),
          })),
        ),
      tokenForUser: tokenProvider.getGitHubToken,
      storeAccountTokens: tokenProvider.storeAccountTokens,
      clearReauthRequired: tokenProvider.clearReauthRequired,
      deleteAccountTokens: tokenProvider.deleteAccountTokens,
      migrateLegacyTokenSecrets: migrateLegacyTokens,
    })),
  ),
);
