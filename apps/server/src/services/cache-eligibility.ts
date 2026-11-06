// Repo-level permission gate for the team walkthrough cache.
//
// A cache entry is only trusted from (and only pushed by) GitHub identities
// that currently hold at least `write` permission on the target repo. This
// binds cache trust to the same authority signal that branch-protection rules
// use ("require approvals from code owners") — revoking a teammate's repo
// access also revokes their cache authority on next verification.
//
// Permissions are asked as the account that tracks the repository, on the
// repository's own host. Results are TTL-cached in memory to avoid hammering
// the GitHub API on every cache hit.

import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { repositories } from "../db/schema";
import { dbTry } from "../effects/db-try";
import { debug } from "../logger";
import { DbService } from "./Db";
import { GitHubAccounts } from "./github/accounts";
import { GitHubGateway } from "./github/gateway";
import type { GitHubClient } from "./github/transport";

type PermLevel = "admin" | "maintain" | "write" | "triage" | "read" | "none";

interface CacheEntry {
  permission: PermLevel;
  fetchedAt: number;
}

const WRITE_TTL_MS = 15 * 60 * 1000; // write/maintain/admin
const READ_TTL_MS = 5 * 60 * 1000; // read/none: shorter, so a new grant is seen sooner

function isEligible(perm: PermLevel): boolean {
  return perm === "write" || perm === "maintain" || perm === "admin";
}

export class CacheEligibility extends Context.Service<
  CacheEligibility,
  {
    /**
     * Returns `true` iff the account tracking the repository currently has
     * at least `write` permission on it. Never raises — any failure → `false`.
     *
     * Used on push to gate whether this machine is allowed to publish to
     * the shared cache. A read-only contributor still receives cache hits;
     * they simply don't push.
     */
    readonly canPush: (repoId: string) => Effect.Effect<boolean>;
    /**
     * Returns `true` iff `signerLogin` on `signerHost` currently has at
     * least `write` permission on `repoFullName`. Never raises — failure → `false`.
     *
     * Used on fetch after signature verification succeeds. Asked as the
     * account that tracks `repoFullName` on `signerHost`; with none (the
     * signer is on another host, or this machine doesn't track the repo
     * there), returns `false` without calling GitHub.
     */
    readonly isSignerEligible: (
      repoFullName: string,
      signerHost: string,
      signerLogin: string,
    ) => Effect.Effect<boolean>;
  }
>()("CacheEligibility") {}

export const CacheEligibilityLive = Layer.effect(
  CacheEligibility,
  Effect.gen(function* () {
    const github = yield* GitHubGateway;
    const accounts = yield* GitHubAccounts;
    const { db } = yield* DbService;

    const permCache = new Map<string, CacheEntry>();

    function getCached(key: string): PermLevel | null {
      const entry = permCache.get(key);
      if (!entry) return null;
      const ttl = isEligible(entry.permission) ? WRITE_TTL_MS : READ_TTL_MS;
      if (Date.now() - entry.fetchedAt < ttl) return entry.permission;
      permCache.delete(key);
      return null;
    }

    const resolvePermission = (
      client: GitHubClient,
      fullName: string,
      login: string,
    ): Effect.Effect<PermLevel> => {
      const key = `${client.host}:${fullName}:${login}`;
      const cached = getCached(key);
      if (cached !== null) return Effect.succeed(cached);
      return github.repos.collaboratorPermission(client, fullName, login).pipe(
        Effect.catch(() => Effect.succeed("none" as PermLevel)),
        Effect.tap((perm) =>
          Effect.sync(() => {
            permCache.set(key, { permission: perm, fetchedAt: Date.now() });
            debug("cache-eligibility", `${login}@${client.host} has ${perm} on ${fullName}`);
          }),
        ),
      );
    };

    return CacheEligibility.of({
      canPush: (repoId) =>
        Effect.gen(function* () {
          const repo = yield* dbTry("read repository", () =>
            db
              .select({ fullName: repositories.fullName, accountId: repositories.accountId })
              .from(repositories)
              .where(eq(repositories.id, repoId))
              .get(),
          );
          if (!repo) return false;
          const { githubLogin } = yield* accounts.profile(repo.accountId);
          if (!githubLogin) return false;
          const client = yield* accounts.clientFor(repo.accountId);
          return isEligible(yield* resolvePermission(client, repo.fullName, githubLogin));
        }).pipe(Effect.catch(() => Effect.succeed(false))),

      isSignerEligible: (repoFullName, signerHost, signerLogin) =>
        Effect.gen(function* () {
          const repo = yield* dbTry("read repository", () =>
            db
              .select({ accountId: repositories.accountId })
              .from(repositories)
              .where(
                and(
                  eq(repositories.fullName, repoFullName),
                  eq(repositories.githubHost, signerHost),
                ),
              )
              .get(),
          );
          if (!repo) return false;
          const client = yield* accounts.clientFor(repo.accountId);
          return isEligible(yield* resolvePermission(client, repoFullName, signerLogin));
        }).pipe(Effect.catch(() => Effect.succeed(false))),
    });
  }),
);
