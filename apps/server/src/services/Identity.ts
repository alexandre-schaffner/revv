import { Context, Effect, Layer } from "effect";
import { auth } from "../auth";
import type { GitHubAuthError } from "../domain/errors";
import type { TokenPair } from "./SecretStore";
import { migrateLegacyTokens } from "./SecretStore";
import { TokenProvider } from "./TokenProvider";

type SessionResult = Awaited<ReturnType<typeof auth.api.getSession>>;

export type AuthSession = NonNullable<SessionResult>;

export interface AccountIdentity {
  readonly accountId: string;
  readonly accessToken: string;
  readonly providerId: string;
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
    readonly tokenFor: (accountId: string) => Effect.Effect<string, GitHubAuthError>;
    readonly tokenForUser: (
      userId: string,
      host?: string,
    ) => Effect.Effect<string, GitHubAuthError>;
    readonly storeAccountTokens: (
      accountId: string,
      host: string,
      tokens: TokenPair,
    ) => Effect.Effect<void>;
    readonly deleteAccountTokens: (accountId: string) => Effect.Effect<void>;
    readonly refreshAccountToken: (accountId: string) => Effect.Effect<string, GitHubAuthError>;
    readonly markReauthRequired: (accountId: string) => Effect.Effect<void>;
    readonly migrateLegacyTokenSecrets: typeof migrateLegacyTokens;
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
      tokenFor: tokenProvider.getTokenByAccountId,
      tokenForUser: tokenProvider.getGitHubToken,
      storeAccountTokens: tokenProvider.storeAccountTokens,
      deleteAccountTokens: tokenProvider.deleteAccountTokens,
      refreshAccountToken: tokenProvider.refreshAccountToken,
      markReauthRequired: tokenProvider.markReauthRequired,
      migrateLegacyTokenSecrets: migrateLegacyTokens,
    })),
  ),
);
