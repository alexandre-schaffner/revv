import type { PullRequest, Repository } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { repositories } from "../db/schema";
import { GitHubAuthError, type GitHubError, type NotFoundError } from "../domain/errors";
import { withDb } from "../effects/with-db";
import { DbService } from "./Db";
import { type CachedDiffFile, DiffCacheService, hasCompleteCachedFiles } from "./DiffCache";
import { GitHubGateway, type PrCommit, type PrFileMeta, type PrMeta } from "./GitHub";
import type { GitHubEtagCache } from "./GitHubEtagCache";
import { PullRequestService } from "./PullRequest";
import { RepositoryService } from "./Repository";
import type { SettingsService } from "./Settings";
import { TokenProvider } from "./TokenProvider";

/**
 * Minimal PR context — the DB-backed trio that almost every PR-scoped feature
 * needs to talk to GitHub.
 */
export interface PrContextBasic {
  readonly pr: PullRequest;
  readonly repo: Repository;
  readonly token: string;
}

/**
 * Full PR context for AI / walkthrough flows — extends {@link PrContextBasic}
 * with freshly-resolved GitHub metadata, the cached diff file list, and the
 * PR commit list (used to seed the agent's required "How we got here"
 * journey chapter).
 */
export interface PrContextWithDiff extends PrContextBasic {
  readonly meta: PrMeta;
  readonly files: Array<{
    readonly filename: string;
    readonly previousFilename: string | null;
    readonly status: string;
    readonly additions: number;
    readonly deletions: number;
    readonly patch: string | null;
  }>;
  readonly commits: readonly PrCommit[];
}

type PrContextError = NotFoundError | GitHubAuthError | GitHubError;

export class PrContextService extends Context.Tag("PrContextService")<
  PrContextService,
  {
    /**
     * Resolve the PR + repo + GitHub token for a given PR id.
     * `userId` is passed through to {@link TokenProvider}; use `'single-user'`
     * when the caller is a background worker with no session context.
     */
    readonly resolveBasic: (
      prId: string,
      userId: string,
    ) => Effect.Effect<PrContextBasic, PrContextError, DbService>;
    /**
     * Resolve the basic context, plus fresh PR metadata (head/base shas) and
     * the cached diff file list. Used by walkthrough streaming + cache checks.
     */
    readonly resolveWithDiff: (
      prId: string,
      userId: string,
    ) => Effect.Effect<
      PrContextWithDiff,
      PrContextError,
      DbService | GitHubEtagCache | SettingsService
    >;
    /**
     * Fresh head/base SHAs for an arbitrary PR. Thin forward to the GitHub
     * gateway — the caller supplies the resolved token and provides the
     * gateway's execution-time deps (Db/Etag/Settings).
     */
    readonly prMeta: (
      repoFullName: string,
      externalId: number,
      token: string,
    ) => Effect.Effect<PrMeta, GitHubError, DbService | GitHubEtagCache | SettingsService>;
    /**
     * Raw changed-file list for an arbitrary PR. Thin forward to the GitHub
     * gateway; unlike {@link resolveWithDiff} this does not touch the diff
     * cache — the recap pipeline owns its own caching.
     */
    readonly prFiles: (
      repoFullName: string,
      externalId: number,
      token: string,
    ) => Effect.Effect<PrFileMeta[], GitHubError, DbService | GitHubEtagCache | SettingsService>;
    readonly prCommits: (
      repoFullName: string,
      externalId: number,
      token: string,
    ) => Effect.Effect<PrCommit[], GitHubError, SettingsService>;
    /**
     * Full PR fetch by number. Thin forward to the GitHub gateway. Used by
     * the recap backfill path to hydrate PRs that never landed in the local
     * mirror.
     */
    readonly fetchPr: (
      repoFullName: string,
      externalId: number,
      token: string,
    ) => Effect.Effect<PullRequest, GitHubError, DbService | GitHubEtagCache | SettingsService>;
    /**
     * Search for PRs closed (or merged) in a time window. Thin forward to the
     * GitHub gateway's issue-search path — note the narrower requirement
     * (SettingsService only, no Db/Etag).
     */
    readonly searchClosedPrs: (
      repoFullName: string,
      sinceIso: string,
      untilIso: string,
      token: string,
    ) => Effect.Effect<
      ReadonlyArray<{
        readonly number: number;
        readonly closedAt: string;
        readonly merged: boolean;
      }>,
      GitHubError,
      SettingsService
    >;
    /**
     * Resolve the GitHub token for a repo via its owning OAuth `accountId`.
     * Returns `null` only when the repo row carries no `accountId`; a token
     * lookup failure surfaces as {@link GitHubAuthError} so the caller can
     * decide whether to degrade. Mirrors the account-lookup in
     * `resolveBasic` for background workers that have no session `userId`.
     */
    readonly resolveRepoToken: (
      repoId: string,
    ) => Effect.Effect<string | null, GitHubAuthError, DbService>;
    /** Look up a repo row by id. Thin forward to {@link RepositoryService}. */
    readonly getRepo: (repoId: string) => Effect.Effect<Repository, NotFoundError, DbService>;
    /** Resolve the owning OAuth account id for a repo row. */
    readonly getAccountIdForRepo: (
      repoId: string,
    ) => Effect.Effect<string, NotFoundError, DbService>;
  }
>() {}

export const PrContextServiceLive = Layer.effect(
  PrContextService,
  Effect.gen(function* () {
    const prService = yield* PullRequestService;
    const repoService = yield* RepositoryService;
    const tokenProvider = yield* TokenProvider;
    const github = yield* GitHubGateway;
    const diffCache = yield* DiffCacheService;

    const resolveBasic = (prId: string, userId: string) =>
      Effect.gen(function* () {
        const pr = yield* prService.getPr(prId);
        const repo = yield* repoService.getRepoById(pr.repositoryId);
        // Look up the repo's owning OAuth account directly. The legacy
        // `getGitHubToken(userId, host)` path falls back to "first user, first
        // matching providerId" which silently picks the wrong identity once
        // multiple users or multiple accounts per host coexist on the machine.
        const { db } = yield* DbService;
        const repoRow = db
          .select({ accountId: repositories.accountId })
          .from(repositories)
          .where(eq(repositories.id, repo.id))
          .get();
        const token = repoRow
          ? yield* tokenProvider.getTokenByAccountId(repoRow.accountId)
          : yield* tokenProvider.getGitHubToken(userId, repo.githubHost).pipe(
              Effect.catchAll(() =>
                Effect.fail(
                  new GitHubAuthError({
                    message: `No account_id on repo ${repo.id} and no fallback token available`,
                  }),
                ),
              ),
            );
        return { pr, repo, token } satisfies PrContextBasic;
      });

    // Cache-or-fetch diff files. Inlined from DiffCache.getOrFetchDiffFiles so
    // we can use the service values captured in this layer's closure without
    // leaking GitHubGateway / DiffCacheService into the returned Effect's
    // context requirements.
    const cacheOrFetchFiles = (
      prId: string,
      repoFullName: string,
      prExternalId: number,
      token: string,
      expectedChangedFiles: number,
    ) =>
      Effect.gen(function* () {
        const { db } = yield* DbService;
        const cached = yield* withDb(db, diffCache.getCachedFiles(prId));
        if (cached !== null && hasCompleteCachedFiles(cached, expectedChangedFiles)) return cached;
        const fileList = yield* github.prs.files(repoFullName, prExternalId, token);
        const fresh: CachedDiffFile[] = fileList.map((f) => ({
          path: f.filename,
          oldPath: f.previousFilename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
          fetchedAt: new Date().toISOString(),
        }));
        yield* withDb(db, diffCache.cacheFiles(prId, fresh));
        return fresh;
      });

    const resolveWithDiff = (prId: string, userId: string) =>
      Effect.gen(function* () {
        const basic = yield* resolveBasic(prId, userId);
        const meta = yield* github.prs.meta(basic.repo.fullName, basic.pr.externalId, basic.token);
        const cachedFiles = yield* cacheOrFetchFiles(
          basic.pr.id,
          basic.repo.fullName,
          basic.pr.externalId,
          basic.token,
          basic.pr.changedFiles,
        );
        const files = cachedFiles.map((f) => ({
          filename: f.path,
          previousFilename: f.oldPath,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
        }));
        // Commit list seeds the agent's journey chapter. Best-effort: if
        // GitHub fails on this endpoint we'd rather still ship the
        // walkthrough than block on it, so a failure here would propagate;
        // any callers that can't tolerate the failure should add their own
        // fallback. Today the only caller is the walkthrough start path
        // which already mapErrors GitHub failures, so propagation is safe.
        const commits = yield* github.prs.commits(
          basic.repo.fullName,
          basic.pr.externalId,
          basic.token,
        );
        return { ...basic, meta, files, commits } satisfies PrContextWithDiff;
      });

    // ── Thin GitHub-read passthroughs ───────────────────────────────────
    // These forward to the gateway verbatim and preserve its exact
    // requirement channel; the deps are discharged by the caller, not here.
    // They exist so feature modules reach GitHub through PrContext only
    // (enforced by scripts/check-import-boundaries.ts).
    const prMeta = (repoFullName: string, externalId: number, token: string) =>
      github.prs.meta(repoFullName, externalId, token);
    const prFiles = (repoFullName: string, externalId: number, token: string) =>
      github.prs.files(repoFullName, externalId, token);
    const prCommits = (repoFullName: string, externalId: number, token: string) =>
      github.prs.commits(repoFullName, externalId, token);
    const fetchPr = (repoFullName: string, externalId: number, token: string) =>
      github.prs.get(repoFullName, externalId, token);
    const searchClosedPrs = (
      repoFullName: string,
      sinceIso: string,
      untilIso: string,
      token: string,
    ) => github.prs.searchClosedInWindow(repoFullName, sinceIso, untilIso, token);

    const resolveRepoToken = (repoId: string) =>
      Effect.gen(function* () {
        const { db } = yield* DbService;
        const row = db
          .select({ accountId: repositories.accountId })
          .from(repositories)
          .where(eq(repositories.id, repoId))
          .get();
        if (!row) return null;
        return yield* tokenProvider.getTokenByAccountId(row.accountId);
      });

    const getRepo = (repoId: string) => repoService.getRepoById(repoId);
    const getAccountIdForRepo = (repoId: string) => repoService.getAccountIdForRepo(repoId);

    return {
      resolveBasic,
      resolveWithDiff,
      prMeta,
      prFiles,
      prCommits,
      fetchPr,
      searchClosedPrs,
      resolveRepoToken,
      getRepo,
      getAccountIdForRepo,
    };
  }),
);
