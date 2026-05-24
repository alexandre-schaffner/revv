// ─── CacheEligibility ─────────────────────────────────────────────────────────
//
// Repo-level permission gate for the team walkthrough cache.
//
// A cache entry is only trusted from (and only pushed by) GitHub identities
// that currently hold at least `write` permission on the target repo. This
// binds cache trust to the same authority signal that branch-protection rules
// use ("require approvals from code owners") — revoking a teammate's repo
// access also revokes their cache authority on next verification.
//
// Results are TTL-cached in memory to avoid hammering the GitHub API on every
// cache hit. The cache is invalidated whenever settings change (e.g. host set
// changes) via the SettingsService.settingsChanges() stream.

import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Stream } from "effect";
import { account, user } from "../db/schema";
import { debug } from "../logger";
import { DbService } from "./Db";
import { GitHubService } from "./GitHub";
import { SettingsService } from "./Settings";

type PermLevel = "admin" | "maintain" | "write" | "triage" | "read" | "none";

interface CacheEntry {
  permission: PermLevel;
  fetchedAt: number;
}

const WRITE_TTL_MS = 15 * 60 * 1000; // 15 min for write/maintain/admin
const READ_TTL_MS = 5 * 60 * 1000; // 5 min for read/none (faster refresh on access grants)

function isEligible(perm: PermLevel): boolean {
  return perm === "write" || perm === "maintain" || perm === "admin";
}

function extractHostFromProviderId(providerId: string): string {
  if (providerId.startsWith("github:")) return providerId.slice("github:".length);
  return "github.com";
}

// ── Context tag ───────────────────────────────────────────────────────────────

export class CacheEligibility extends Context.Tag("CacheEligibility")<
  CacheEligibility,
  {
    /**
     * Returns `true` iff the local user currently has at least `write`
     * permission on `repoFullName`. Never raises — any failure → `false`.
     *
     * Used on push to gate whether this machine is allowed to publish to
     * the shared cache. A read-only contributor still receives cache hits;
     * they simply don't push.
     */
    readonly canPush: (repoFullName: string) => Effect.Effect<boolean>;
    /**
     * Returns `true` iff `signerLogin` on `signerHost` currently has at
     * least `write` permission on `repoFullName`. Never raises — failure → `false`.
     *
     * Used on fetch after signature verification succeeds. If `signerHost`
     * doesn't match any of the local user's authenticated hosts, returns
     * `false` immediately without hitting the GitHub API.
     */
    readonly isSignerEligible: (
      repoFullName: string,
      signerHost: string,
      signerLogin: string,
    ) => Effect.Effect<boolean>;
  }
>() {}

// ── Layer ─────────────────────────────────────────────────────────────────────

export const CacheEligibilityLive = Layer.effect(
  CacheEligibility,
  Effect.gen(function* () {
    const settingsSvc = yield* SettingsService;
    const githubSvc = yield* GitHubService;
    const { db } = yield* DbService;

    const permCache = new Map<string, CacheEntry>();

    function permCacheKey(host: string, owner: string, repo: string, login: string): string {
      return `${host}:${owner}/${repo}:${login}`;
    }

    function getCached(key: string): PermLevel | null {
      const entry = permCache.get(key);
      if (!entry) return null;
      const ttl = isEligible(entry.permission) ? WRITE_TTL_MS : READ_TTL_MS;
      if (Date.now() - entry.fetchedAt < ttl) return entry.permission;
      permCache.delete(key);
      return null;
    }

    function getLocalAccountsForHost(targetHost: string): { login: string; token: string } | null {
      const firstUser = db.select({ id: user.id }).from(user).limit(1).get();
      if (!firstUser) return null;

      const rows = db
        .select({
          providerId: account.providerId,
          githubLogin: account.githubLogin,
          accessToken: account.accessToken,
        })
        .from(account)
        .where(eq(account.userId, firstUser.id))
        .all();

      for (const row of rows) {
        if (!row.githubLogin || !row.accessToken) continue;
        const host = extractHostFromProviderId(row.providerId);
        if (host === targetHost) {
          return { login: row.githubLogin, token: row.accessToken };
        }
      }
      return null;
    }

    function getAllLocalHosts(): Set<string> {
      const firstUser = db.select({ id: user.id }).from(user).limit(1).get();
      if (!firstUser) return new Set();
      const rows = db
        .select({ providerId: account.providerId })
        .from(account)
        .where(eq(account.userId, firstUser.id))
        .all();
      return new Set(rows.map((r) => extractHostFromProviderId(r.providerId)));
    }

    const fetchPermission = (
      token: string,
      host: string,
      owner: string,
      repo: string,
      login: string,
    ): Effect.Effect<PermLevel> =>
      githubSvc
        .getCollaboratorPermission(token, host, owner, repo, login)
        .pipe(Effect.catchAll(() => Effect.succeed("none" as PermLevel)));

    // Invalidate on settings changes (host set may change).
    yield* Effect.fork(
      settingsSvc
        .settingsChanges()
        .pipe(Stream.runForEach(() => Effect.sync(() => permCache.clear()))),
    );

    const resolvePermission = (
      host: string,
      owner: string,
      repo: string,
      login: string,
      token: string,
    ): Effect.Effect<PermLevel> => {
      const key = permCacheKey(host, owner, repo, login);
      const cached = getCached(key);
      if (cached !== null) return Effect.succeed(cached);

      return fetchPermission(token, host, owner, repo, login).pipe(
        Effect.tap((perm) =>
          Effect.sync(() => {
            permCache.set(key, { permission: perm, fetchedAt: Date.now() });
            debug("cache-eligibility", `${login}@${host} has ${perm} on ${owner}/${repo}`);
          }),
        ),
      );
    };

    return CacheEligibility.of({
      canPush: (repoFullName) =>
        Effect.gen(function* () {
          const parts = repoFullName.split("/");
          if (parts.length !== 2) return false;
          const [owner, repo] = parts as [string, string];

          // Use settings host as the authority for "which account do I use?"
          const settings = yield* settingsSvc
            .getSettings()
            .pipe(Effect.catchAll(() => Effect.succeed(null)));
          const host = settings?.githubHost ?? "github.com";

          const localAcct = yield* Effect.try({
            try: () => getLocalAccountsForHost(host),
            catch: () => null,
          }).pipe(Effect.catchAll(() => Effect.succeed(null)));

          if (!localAcct) return false;

          const perm = yield* resolvePermission(
            host,
            owner,
            repo,
            localAcct.login,
            localAcct.token,
          );
          return isEligible(perm);
        }).pipe(Effect.catchAll(() => Effect.succeed(false))),

      isSignerEligible: (repoFullName, signerHost, signerLogin) =>
        Effect.gen(function* () {
          const parts = repoFullName.split("/");
          if (parts.length !== 2) return false;
          const [owner, repo] = parts as [string, string];

          // The local user must have an account on signerHost to query permissions.
          const localHosts = yield* Effect.try({
            try: () => getAllLocalHosts(),
            catch: () => new Set<string>(),
          }).pipe(Effect.catchAll(() => Effect.succeed(new Set<string>())));

          if (!localHosts.has(signerHost)) return false;

          // Use the local user's token for this host to query the signer's permission.
          const localAcct = yield* Effect.try({
            try: () => getLocalAccountsForHost(signerHost),
            catch: () => null,
          }).pipe(Effect.catchAll(() => Effect.succeed(null)));

          if (!localAcct) return false;

          const perm = yield* resolvePermission(
            signerHost,
            owner,
            repo,
            signerLogin,
            localAcct.token,
          );
          return isEligible(perm);
        }).pipe(Effect.catchAll(() => Effect.succeed(false))),
    });
  }),
);
