// Credential lifecycle and checkout→PR resolution for coding agents that run
// outside Revv's own agent lifecycle. Each provider gets one account-scoped
// credential (stored only as a SHA-256 digest) plus a per-account/provider
// install of the shared stdio MCP bridge. The bridge never names a PR: the
// server derives it from the credential's account, a tracked repository, and
// the checkout's commit ancestry.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  API_PORT,
  DEV_API_PORT,
  EXTERNAL_AGENT_PROVIDERS,
  EXTERNAL_AGENT_SCOPES,
  type ExternalAgentProvider,
  type ExternalAgentScope,
  type ExternalIntegrationStatus,
  isExternalAgentProvider,
  SHA_PATTERN,
} from "@revv/shared";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { serverEnv } from "../config";
import { externalIntegrations } from "../db/schema/external-integrations";
import { pullRequests } from "../db/schema/pull-requests";
import { repositories } from "../db/schema/repositories";
import { ExternalIntegrationError } from "../domain/errors";
import { logError } from "../logger";
import { DbService } from "./Db";
import {
  type ExternalIntegrationInstaller,
  externalIntegrationError,
  externalIntegrationInstaller,
  findIntegrationsDirectory,
  type InstalledBinding,
} from "./external-integrations/install";

/** Short, provider-identifying token prefixes so a leaked value is traceable. */
const TOKEN_PREFIX: Readonly<Record<ExternalAgentProvider, string>> = {
  "claude-code": "revv_cc",
  codex: "revv_cx",
  opencode: "revv_oc",
  cursor: "revv_cu",
};

export interface ExternalProjectIdentity {
  readonly repositoryFullName: string;
  readonly headCandidates: readonly string[];
  readonly branch: string | null;
}

export interface ExternalResolvedContext {
  readonly provider: ExternalAgentProvider;
  readonly integrationId: string;
  readonly accountId: string;
  readonly prId: string;
  readonly prHeadSha: string | null;
  readonly scopes: readonly ExternalAgentScope[];
}

export interface ExternalAuthorizedContext {
  readonly provider: ExternalAgentProvider;
  readonly integrationId: string;
  readonly accountId: string;
  readonly scopes: readonly ExternalAgentScope[];
}

export interface ExternalPullRequestCandidate {
  readonly id: string;
  readonly headSha: string | null;
  readonly sourceBranch: string;
}

/**
 * Pick the PR a checkout is working on: the nearest reviewed head in the
 * commit ancestry, or — only when no head matches — an unambiguous branch.
 */
export function selectPullRequestForCheckout<T extends ExternalPullRequestCandidate>(
  candidates: readonly T[],
  headCandidates: readonly string[],
  branch: string | null,
): T | null {
  const rank = new Map(headCandidates.map((sha, index) => [sha.toLowerCase(), index]));
  const exact = candidates
    .filter((pullRequest) =>
      pullRequest.headSha === null ? false : rank.has(pullRequest.headSha.toLowerCase()),
    )
    .sort(
      (left, right) =>
        (rank.get(left.headSha?.toLowerCase() ?? "") ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(right.headSha?.toLowerCase() ?? "") ?? Number.MAX_SAFE_INTEGER),
    )[0];
  if (exact) return exact;
  if (!branch) return null;
  const branchMatches = candidates.filter((pullRequest) => pullRequest.sourceBranch === branch);
  return branchMatches.length === 1 ? (branchMatches[0] ?? null) : null;
}

/** The MCP route the bridges of this server's installs talk to. */
function bridgeApiUrl(): string {
  return `http://${serverEnv.host}:${serverEnv.port}/mcp/external`;
}

/**
 * Where the bridge of a config written before it carried `REVV_API_URL`
 * looks for Revv: both channels' default ports (legacy-upgrade: unpinnedBridge).
 */
const LEGACY_BRIDGE_URLS = [API_PORT, DEV_API_PORT].map(
  (port) => `http://127.0.0.1:${port}/mcp/external`,
);

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Whether an install is this server's to rewrite or remove. A server booted
 * on a copy of another's database holds the same credential rows, so the
 * credential alone doesn't say: the install also has to talk to this server.
 */
function isThisServersInstall(binding: InstalledBinding, credentialHash: string): boolean {
  if (tokenHash(binding.token) !== credentialHash) return false;
  return binding.apiUrl === null
    ? LEGACY_BRIDGE_URLS.includes(bridgeApiUrl())
    : binding.apiUrl === bridgeApiUrl();
}

export function isIntegrationCredentialActive(
  credential: { readonly revokedAt: string | null; readonly expiresAt: string },
  now: number = Date.now(),
): boolean {
  return credential.revokedAt === null && Date.parse(credential.expiresAt) > now;
}

function asIntegrationError(
  code: ExternalIntegrationError["code"],
  message: string,
): (cause: unknown) => ExternalIntegrationError {
  return (cause) =>
    cause instanceof ExternalIntegrationError
      ? cause
      : externalIntegrationError(code, message, cause);
}

export class ExternalIntegrations extends Context.Service<
  ExternalIntegrations,
  {
    readonly status: (
      accountId: string,
    ) => Effect.Effect<readonly ExternalIntegrationStatus[], ExternalIntegrationError>;
    readonly connect: (args: {
      readonly accountId: string;
      readonly userId: string;
      readonly provider: ExternalAgentProvider;
    }) => Effect.Effect<ExternalIntegrationStatus, ExternalIntegrationError>;
    readonly disconnect: (
      accountId: string,
      provider: ExternalAgentProvider,
    ) => Effect.Effect<void, ExternalIntegrationError>;
    /**
     * Remove the install of every credential the account holds, before its
     * rows go: the agents' configs carry the plaintext token, and once the
     * rows are deleted nothing can find them again.
     */
    readonly uninstallAccount: (accountId: string) => Effect.Effect<void, ExternalIntegrationError>;
    /**
     * Rewrite every file Revv owns in the agents' configs (bridge copy,
     * guide, and the entry's command, URL and proxy bypass) for each active
     * credential whose install is this server's, so a release's fixes reach
     * installs without a reconnect. Run once per boot.
     */
    readonly refreshInstalls: () => Effect.Effect<void>;
    readonly authenticate: (
      token: string,
    ) => Effect.Effect<ExternalAuthorizedContext, ExternalIntegrationError>;
    readonly resolve: (
      token: string,
      project: ExternalProjectIdentity,
    ) => Effect.Effect<ExternalResolvedContext, ExternalIntegrationError>;
  }
>()("ExternalIntegrations") {}

/**
 * The service over the agent configs under `home` (Codex's under `CODEX_HOME`
 * when set): the user's home, or a temp dir in tests. Rewriting or removing
 * an install is refused when it belongs to another server.
 */
export const externalIntegrationsLayer = (home: string) =>
  Layer.effect(
    ExternalIntegrations,
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const installerFor = (provider: ExternalAgentProvider, accountId: string) =>
        externalIntegrationInstaller(provider, accountId, home);

      const removeInstall = (
        installer: ExternalIntegrationInstaller,
        credentialHash: string | null,
      ) =>
        Effect.try({
          try: () => {
            const binding = installer.installedBinding();
            if (
              binding !== null &&
              (credentialHash === null || !isThisServersInstall(binding, credentialHash))
            ) {
              logError(
                "external-integrations",
                `leaving ${installer.clientName} installed: it belongs to another Revv server`,
              );
              return;
            }
            installer.uninstall();
          },
          catch: asIntegrationError(
            "INSTALL_FAILED",
            "Credential revoked, but the client configuration could not be removed.",
          ),
        });

      const status = Effect.fn("ExternalIntegrations.status")(function* (accountId: string) {
        const rows = yield* Effect.try({
          try: () =>
            db
              .select({
                provider: externalIntegrations.provider,
                createdAt: externalIntegrations.createdAt,
                expiresAt: externalIntegrations.expiresAt,
                lastUsedAt: externalIntegrations.lastUsedAt,
                revokedAt: externalIntegrations.revokedAt,
              })
              .from(externalIntegrations)
              .where(eq(externalIntegrations.accountId, accountId))
              .all(),
          catch: (cause) =>
            externalIntegrationError(
              "INTERNAL",
              "Could not read integration connection state.",
              cause,
            ),
        });
        const byProvider = new Map(rows.map((row) => [row.provider, row]));
        const now = Date.now();
        return EXTERNAL_AGENT_PROVIDERS.map((provider): ExternalIntegrationStatus => {
          const row = byProvider.get(provider);
          const active = row ? isIntegrationCredentialActive(row, now) : false;
          const installer = installerFor(provider, accountId);
          return {
            provider,
            connected: Boolean(row && active),
            clientConfigured: installer.installed(),
            clientName: installer.clientName,
            activation: installer.activation,
            createdAt: row?.createdAt ?? null,
            lastUsedAt: row?.lastUsedAt ?? null,
            expiresAt: row?.expiresAt ?? null,
          };
        });
      });

      const connect = Effect.fn("ExternalIntegrations.connect")(function* (args: {
        readonly accountId: string;
        readonly userId: string;
        readonly provider: ExternalAgentProvider;
      }) {
        const token = `${TOKEN_PREFIX[args.provider]}_${randomBytes(32).toString("base64url")}`;
        const id = randomUUID();
        const now = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
        const installer = installerFor(args.provider, args.accountId);

        const integrationsDirectory = yield* Effect.try({
          try: findIntegrationsDirectory,
          catch: asIntegrationError(
            "INSTALL_FAILED",
            "Could not locate the bundled Revv integration assets.",
          ),
        });

        yield* Effect.try({
          try: () =>
            installer.install({
              runtimeExecutable: process.execPath,
              token,
              integrationsDirectory,
              apiUrl: bridgeApiUrl(),
            }),
          catch: asIntegrationError("INSTALL_FAILED", "Could not install the Revv integration."),
        });

        yield* Effect.try({
          try: () =>
            db
              .insert(externalIntegrations)
              .values({
                id,
                provider: args.provider,
                userId: args.userId,
                accountId: args.accountId,
                tokenHash: tokenHash(token),
                // Read only by older Revv versions; this one grants every scope.
                scopes: JSON.stringify(EXTERNAL_AGENT_SCOPES),
                createdAt: now,
                expiresAt,
                lastUsedAt: null,
                revokedAt: null,
              })
              .onConflictDoUpdate({
                target: [externalIntegrations.provider, externalIntegrations.accountId],
                set: {
                  userId: args.userId,
                  tokenHash: tokenHash(token),
                  scopes: JSON.stringify(EXTERNAL_AGENT_SCOPES),
                  createdAt: now,
                  expiresAt,
                  lastUsedAt: null,
                  revokedAt: null,
                },
              })
              .run(),
          catch: (cause) =>
            externalIntegrationError(
              "INTERNAL",
              "The integration was installed, but Revv could not activate its credential. Reconnect to retry.",
              cause,
            ),
        });

        return {
          provider: args.provider,
          connected: true,
          clientConfigured: true,
          clientName: installer.clientName,
          activation: installer.activation,
          createdAt: now,
          lastUsedAt: null,
          expiresAt,
        };
      });

      const disconnect = Effect.fn("ExternalIntegrations.disconnect")(function* (
        accountId: string,
        provider: ExternalAgentProvider,
      ) {
        const revoked = yield* Effect.try({
          try: () =>
            db
              .update(externalIntegrations)
              .set({ revokedAt: new Date().toISOString() })
              .where(
                and(
                  eq(externalIntegrations.provider, provider),
                  eq(externalIntegrations.accountId, accountId),
                ),
              )
              .returning({ tokenHash: externalIntegrations.tokenHash })
              .get(),
          catch: (cause) =>
            externalIntegrationError(
              "INTERNAL",
              "Could not revoke the integration credential.",
              cause,
            ),
        });
        yield* removeInstall(installerFor(provider, accountId), revoked?.tokenHash ?? null);
      });

      const uninstallAccount = Effect.fn("ExternalIntegrations.uninstallAccount")(function* (
        accountId: string,
      ) {
        const rows = yield* Effect.try({
          try: () =>
            db
              .select({
                provider: externalIntegrations.provider,
                tokenHash: externalIntegrations.tokenHash,
              })
              .from(externalIntegrations)
              .where(eq(externalIntegrations.accountId, accountId))
              .all(),
          catch: (cause) =>
            externalIntegrationError("INTERNAL", "Could not read integration credentials.", cause),
        });
        let failure: ExternalIntegrationError | null = null;
        for (const row of rows) {
          if (!isExternalAgentProvider(row.provider)) continue;
          const removed = yield* Effect.result(
            removeInstall(installerFor(row.provider, accountId), row.tokenHash),
          );
          if (removed._tag === "Failure") failure ??= removed.failure;
        }
        if (failure) return yield* Effect.fail(failure);
      });

      const refreshInstalls = Effect.fn("ExternalIntegrations.refreshInstalls")(
        function* () {
          const integrationsDirectory = yield* Effect.try({
            try: findIntegrationsDirectory,
            catch: asIntegrationError("INSTALL_FAILED", "Could not locate the bundled assets."),
          });
          const rows = yield* Effect.try({
            try: () =>
              db
                .select({
                  provider: externalIntegrations.provider,
                  accountId: externalIntegrations.accountId,
                  tokenHash: externalIntegrations.tokenHash,
                  expiresAt: externalIntegrations.expiresAt,
                  revokedAt: externalIntegrations.revokedAt,
                })
                .from(externalIntegrations)
                .all(),
            catch: (cause) =>
              externalIntegrationError(
                "INTERNAL",
                "Could not read integration credentials.",
                cause,
              ),
          });
          for (const row of rows) {
            if (!isExternalAgentProvider(row.provider) || !isIntegrationCredentialActive(row))
              continue;
            const installer = installerFor(row.provider, row.accountId);
            try {
              const binding = installer.installedBinding();
              if (binding === null || !isThisServersInstall(binding, row.tokenHash)) continue;
              installer.install({
                runtimeExecutable: process.execPath,
                token: binding.token,
                integrationsDirectory,
                apiUrl: bridgeApiUrl(),
              });
            } catch (err) {
              logError(
                "external-integrations",
                `refreshing the ${row.provider} install failed:`,
                err,
              );
            }
          }
        },
        Effect.catch((err) =>
          Effect.sync(() => logError("external-integrations", "refreshing installs failed:", err)),
        ),
      );

      const authenticate = Effect.fn("ExternalIntegrations.authenticate")(function* (
        token: string,
      ) {
        const integration = yield* Effect.try({
          try: () =>
            db
              .select()
              .from(externalIntegrations)
              .where(eq(externalIntegrations.tokenHash, tokenHash(token)))
              .get(),
          catch: (cause) =>
            externalIntegrationError(
              "INTERNAL",
              "Could not validate the integration token.",
              cause,
            ),
        });
        if (
          !integration ||
          !isIntegrationCredentialActive(integration) ||
          !isExternalAgentProvider(integration.provider)
        ) {
          return yield* Effect.fail(
            externalIntegrationError(
              "INVALID_CREDENTIAL",
              "The Revv integration credential is invalid, expired, or revoked.",
            ),
          );
        }

        const usedAt = new Date().toISOString();
        yield* Effect.try({
          try: () =>
            db
              .update(externalIntegrations)
              .set({ lastUsedAt: usedAt })
              .where(eq(externalIntegrations.id, integration.id))
              .run(),
          catch: (cause) =>
            externalIntegrationError("INTERNAL", "Could not update integration usage.", cause),
        });

        return {
          provider: integration.provider,
          integrationId: integration.id,
          accountId: integration.accountId,
          scopes: EXTERNAL_AGENT_SCOPES,
        };
      });

      const resolveProject = Effect.fn("ExternalIntegrations.resolve")(function* (
        token: string,
        project: ExternalProjectIdentity,
      ) {
        const authorized = yield* authenticate(token);
        const cleanRepository = project.repositoryFullName.trim();
        const headCandidates = project.headCandidates
          .filter((sha) => SHA_PATTERN.test(sha))
          .slice(0, 64);
        if (!/^[^/\s]+\/[^/\s]+$/.test(cleanRepository) || headCandidates.length === 0) {
          return yield* Effect.fail(
            externalIntegrationError("INVALID_PROJECT", "The agent checkout identity is invalid."),
          );
        }

        const repoRows = yield* Effect.try({
          try: () =>
            db
              .select()
              .from(repositories)
              .where(eq(repositories.accountId, authorized.accountId))
              .all(),
          catch: (cause) =>
            externalIntegrationError(
              "INTERNAL",
              "Could not resolve the tracked repository.",
              cause,
            ),
        });
        const repo = repoRows.find(
          (row) => row.fullName.toLowerCase() === cleanRepository.toLowerCase(),
        );
        if (!repo) {
          return yield* Effect.fail(
            externalIntegrationError(
              "INVALID_PROJECT",
              `${cleanRepository} is not tracked by the connected Revv account.`,
            ),
          );
        }

        const prs = yield* Effect.try({
          try: () =>
            db
              .select()
              .from(pullRequests)
              .where(and(eq(pullRequests.repositoryId, repo.id), eq(pullRequests.status, "open")))
              .all(),
          catch: (cause) =>
            externalIntegrationError(
              "INTERNAL",
              "Could not resolve a pull request for the checkout.",
              cause,
            ),
        });
        const matched = selectPullRequestForCheckout(prs, headCandidates, project.branch);
        if (!matched) {
          return yield* Effect.fail(
            externalIntegrationError(
              "PR_NOT_FOUND",
              `No open Revv pull request matches ${cleanRepository} at this checkout's commit ancestry.`,
            ),
          );
        }

        return {
          ...authorized,
          prId: matched.id,
          prHeadSha: matched.headSha,
        };
      });

      return {
        status,
        connect,
        disconnect,
        uninstallAccount,
        refreshInstalls,
        authenticate,
        resolve: resolveProject,
      };
    }),
  );

export const ExternalIntegrationsLive = externalIntegrationsLayer(homedir());
