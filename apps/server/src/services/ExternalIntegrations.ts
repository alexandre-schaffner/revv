// ── External coding-agent integrations ──────────────────────────────────────
//
// Credential lifecycle and checkout→PR resolution for coding agents that run
// outside Revv's own agent lifecycle. Each provider gets one account-scoped
// credential (stored only as a SHA-256 digest) plus a per-provider install of
// the shared stdio MCP bridge. The bridge never names a PR: the server derives
// it from the credential's account, a tracked repository, and the checkout's
// commit ancestry.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EXTERNAL_AGENT_PROVIDERS, type ExternalAgentProvider } from "@revv/shared";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { serverEnv } from "../config";
import { externalIntegrations } from "../db/schema/external-integrations";
import { pullRequests } from "../db/schema/pull-requests";
import { repositories } from "../db/schema/repositories";
import { ExternalIntegrationError } from "../domain/errors";
import { DbService } from "./Db";
import {
  externalIntegrationError,
  externalIntegrationInstaller,
  findIntegrationsDirectory,
} from "./external-integrations/install";

export const EXTERNAL_AGENT_SCOPES = [
  "context:read",
  "walkthrough:edit",
  "issues:resolve",
  "comments:write",
] as const;

export type ExternalAgentScope = (typeof EXTERNAL_AGENT_SCOPES)[number];

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
  readonly userId: string;
  readonly prId: string;
  readonly prHeadSha: string | null;
  readonly scopes: readonly ExternalAgentScope[];
}

export interface ExternalIntegrationStatus {
  readonly provider: ExternalAgentProvider;
  readonly connected: boolean;
  /** The agent's own config still points at Revv (files can be removed by hand). */
  readonly clientConfigured: boolean;
  readonly createdAt: string | null;
  readonly lastUsedAt: string | null;
}

export interface ExternalIntegrationConnectResult extends ExternalIntegrationStatus {
  /** Files and directories the connect just wrote, surfaced in the UI. */
  readonly locations: readonly string[];
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

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseScopes(raw: string): readonly ExternalAgentScope[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is ExternalAgentScope =>
      EXTERNAL_AGENT_SCOPES.some((scope) => scope === value),
    );
  } catch {
    return [];
  }
}

function isProvider(value: string): value is ExternalAgentProvider {
  return (EXTERNAL_AGENT_PROVIDERS as readonly string[]).includes(value);
}

function isSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

/** Map an install-mechanics throw onto a tagged error without losing detail. */
function asIntegrationError(
  code: ExternalIntegrationError["code"],
  message: string,
): (cause: unknown) => ExternalIntegrationError {
  return (cause) =>
    cause instanceof ExternalIntegrationError
      ? cause
      : externalIntegrationError(code, message, cause);
}

export class ExternalIntegrations extends Context.Tag("ExternalIntegrations")<
  ExternalIntegrations,
  {
    readonly status: (
      accountId: string,
    ) => Effect.Effect<readonly ExternalIntegrationStatus[], ExternalIntegrationError>;
    readonly connect: (args: {
      readonly accountId: string;
      readonly userId: string;
      readonly provider: ExternalAgentProvider;
    }) => Effect.Effect<ExternalIntegrationConnectResult, ExternalIntegrationError>;
    readonly disconnect: (
      accountId: string,
      provider: ExternalAgentProvider,
    ) => Effect.Effect<void, ExternalIntegrationError>;
    readonly resolve: (
      token: string,
      project: ExternalProjectIdentity,
    ) => Effect.Effect<ExternalResolvedContext, ExternalIntegrationError>;
  }
>() {}

export const ExternalIntegrationsLive = Layer.effect(
  ExternalIntegrations,
  Effect.gen(function* () {
    const { db } = yield* DbService;

    const status = Effect.fn("ExternalIntegrations.status")(function* (accountId: string) {
      const rows = yield* Effect.try({
        try: () =>
          db
            .select({
              provider: externalIntegrations.provider,
              createdAt: externalIntegrations.createdAt,
              lastUsedAt: externalIntegrations.lastUsedAt,
              revokedAt: externalIntegrations.revokedAt,
            })
            .from(externalIntegrations)
            .where(eq(externalIntegrations.accountId, accountId))
            .all(),
        catch: (cause) =>
          externalIntegrationError(
            "NOT_CONNECTED",
            "Could not read integration connection state.",
            cause,
          ),
      });
      const byProvider = new Map(rows.map((row) => [row.provider, row]));
      return EXTERNAL_AGENT_PROVIDERS.map((provider): ExternalIntegrationStatus => {
        const row = byProvider.get(provider);
        return {
          provider,
          connected: Boolean(row && row.revokedAt === null),
          clientConfigured: externalIntegrationInstaller(provider).installed(),
          createdAt: row?.createdAt ?? null,
          lastUsedAt: row?.lastUsedAt ?? null,
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
      const installer = externalIntegrationInstaller(args.provider);

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
            apiUrl: `http://127.0.0.1:${serverEnv.port}/mcp/external`,
            integrationsDirectory,
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
              scopes: JSON.stringify(EXTERNAL_AGENT_SCOPES),
              createdAt: now,
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
                lastUsedAt: null,
                revokedAt: null,
              },
            })
            .run(),
        catch: (cause) =>
          externalIntegrationError(
            "INSTALL_FAILED",
            "The integration was installed, but Revv could not activate its credential. Reconnect to retry.",
            cause,
          ),
      });

      return {
        provider: args.provider,
        connected: true,
        clientConfigured: true,
        createdAt: now,
        lastUsedAt: null,
        locations: installer.locations,
      };
    });

    const disconnect = Effect.fn("ExternalIntegrations.disconnect")(function* (
      accountId: string,
      provider: ExternalAgentProvider,
    ) {
      const now = new Date().toISOString();
      yield* Effect.try({
        try: () =>
          db
            .update(externalIntegrations)
            .set({ revokedAt: now })
            .where(
              and(
                eq(externalIntegrations.provider, provider),
                eq(externalIntegrations.accountId, accountId),
              ),
            )
            .run(),
        catch: (cause) =>
          externalIntegrationError(
            "NOT_CONNECTED",
            "Could not revoke the integration credential.",
            cause,
          ),
      });
      yield* Effect.try({
        try: () => externalIntegrationInstaller(provider).uninstall(),
        catch: asIntegrationError(
          "INSTALL_FAILED",
          "Credential revoked, but the client configuration could not be removed.",
        ),
      });
    });

    const resolveProject = Effect.fn("ExternalIntegrations.resolve")(function* (
      token: string,
      project: ExternalProjectIdentity,
    ) {
      const cleanRepository = project.repositoryFullName.trim();
      const headCandidates = project.headCandidates.filter(isSha).slice(0, 64);
      if (!/^[^/\s]+\/[^/\s]+$/.test(cleanRepository) || headCandidates.length === 0) {
        return yield* Effect.fail(
          externalIntegrationError("INVALID_PROJECT", "The agent checkout identity is invalid."),
        );
      }

      const integration = yield* Effect.try({
        try: () =>
          db
            .select()
            .from(externalIntegrations)
            .where(eq(externalIntegrations.tokenHash, tokenHash(token)))
            .get(),
        catch: (cause) =>
          externalIntegrationError(
            "INVALID_CREDENTIAL",
            "Could not validate the integration token.",
            cause,
          ),
      });
      if (!integration || integration.revokedAt !== null || !isProvider(integration.provider)) {
        return yield* Effect.fail(
          externalIntegrationError(
            "INVALID_CREDENTIAL",
            "The Revv integration credential is invalid or revoked.",
          ),
        );
      }

      const repoRows = yield* Effect.try({
        try: () =>
          db
            .select()
            .from(repositories)
            .where(eq(repositories.accountId, integration.accountId))
            .all(),
        catch: (cause) =>
          externalIntegrationError(
            "INVALID_PROJECT",
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
            "PR_NOT_FOUND",
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

      const usedAt = new Date().toISOString();
      yield* Effect.try({
        try: () =>
          db
            .update(externalIntegrations)
            .set({ lastUsedAt: usedAt })
            .where(eq(externalIntegrations.id, integration.id))
            .run(),
        catch: (cause) =>
          externalIntegrationError(
            "INVALID_CREDENTIAL",
            "Could not update integration usage.",
            cause,
          ),
      });

      return {
        provider: integration.provider,
        integrationId: integration.id,
        accountId: integration.accountId,
        userId: integration.userId,
        prId: matched.id,
        prHeadSha: matched.headSha,
        scopes: parseScopes(integration.scopes),
      };
    });

    return { status, connect, disconnect, resolve: resolveProject };
  }),
);
