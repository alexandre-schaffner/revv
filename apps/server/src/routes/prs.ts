import {
  guessImageContentType,
  MERGE_METHODS,
  normalizeGithubHost,
  sameGithubHost,
} from "@revv/shared";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { suggestionsForPr } from "../ai/providers/suggestions";
import { pinnedPullRequests } from "../db/schema";
import { dbTry } from "../effects/db-try";
import { RepoCloneService } from "../services/clone/RepoClone";
import { DbService } from "../services/Db";
import { DiffCacheService, toCachedDiffFiles } from "../services/DiffCache";
import { GitHubGateway } from "../services/github/gateway";
import { checkMergeEligibility } from "../services/merge-eligibility";
import { PollScheduler } from "../services/PollScheduler";
import { PrContextService } from "../services/PrContext";
import { PrMirror } from "../services/PrMirror";
import { PullRequestService } from "../services/PullRequest";
import { resolvePullRequestLink } from "../services/pr-deep-link";
import {
  prFilesWithPrerender,
  SSR_PATCH_BYTE_LIMIT,
  SSR_PATCH_LINE_LIMIT,
} from "../services/pr-file-prerender";
import { RepositoryService } from "../services/Repository";
import { ReviewService } from "../services/Review";
import { SyncService } from "../services/Sync";
import { runRoute, withAccount, withAuth } from "./middleware";
import { ownedBy } from "./ownership";
import { literalUnion } from "./schemas";

/**
 * Resolve the `?at=` query param to the SHA the review should be scoped to,
 * or `null` for "the whole PR".
 *
 * Selecting the head commit is *identical* to selecting nothing, so it
 * normalises to `null` and structurally takes the cached full-PR path — the
 * default page load cannot regress into a compare call. The comparison is
 * prefix-tolerant because the client hands back whatever length of SHA the
 * commits list gave it.
 */
function resolveScopedSha(at: string | undefined, headSha: string | null): string | null {
  if (at === undefined) return null;
  if (headSha === null) return at;
  const shorter = Math.min(at.length, headSha.length);
  const isHead = at.slice(0, shorter).toLowerCase() === headSha.slice(0, shorter).toLowerCase();
  return isHead ? null : at;
}

/** The PR lists and whole-list actions: the active account's view. */
const prListRoutes = new Elysia({ prefix: "/api/prs" })
  .use(withAccount)
  .get(
    "/",
    async (ctx) => {
      const repoId = ctx.query.repo;
      return runRoute(
        Effect.gen(function* () {
          const prService = yield* PullRequestService;
          const { accountId } = ctx.account;
          return yield* prService.listPrs(accountId, repoId);
        }),
      );
    },
    { query: t.Object({ repo: t.Optional(t.String()) }) },
  )
  .post(
    "/resolve-link",
    async (ctx) => {
      const expectedHost = normalizeGithubHost(ctx.body.githubHost);
      const activeHost = ctx.account.host;

      // This branch must stay before AppRuntime/service access. A mismatched
      // account is a recovery state, not permission to probe another
      // account's database rows or GitHub token.
      if (!sameGithubHost(activeHost, expectedHost)) {
        return { status: "account_mismatch" as const, activeHost, expectedHost };
      }

      return runRoute(
        Effect.gen(function* () {
          const repositoryService = yield* RepositoryService;
          const pullRequestService = yield* PullRequestService;
          const github = yield* GitHubGateway;
          const mirror = yield* PrMirror;
          const { accountId, client } = ctx.account;

          return yield* resolvePullRequestLink(
            {
              findRepository: (fullName) =>
                repositoryService.getRepoByFullName(fullName, accountId),
              findCachedPullRequest: (id) => pullRequestService.getPr(id).pipe(Effect.option),
              fetchPullRequest: (repository, number) =>
                github.prs.get(client, repository.fullName, repository.id, number),
              upsertPullRequest: (pullRequest) => mirror.apply([pullRequest]).pipe(Effect.asVoid),
            },
            ctx.body,
          );
        }),
      );
    },
    {
      body: t.Object({
        githubHost: t.String({ minLength: 1, pattern: "^[A-Za-z0-9.-]+$" }),
        repositoryFullName: t.String({
          minLength: 3,
          pattern: "^[^/\\s]+/[^/\\s]+$",
        }),
        number: t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      }),
    },
  )
  .get(
    "/archived",
    async (ctx) => {
      const params: { cursor?: string; authorLogins?: string[] } = {};
      if (ctx.query.cursor !== undefined) params.cursor = ctx.query.cursor;
      if (ctx.query.authors !== undefined) {
        // GitHub logins never contain commas.
        const logins = ctx.query.authors.split(",").filter((s) => s.length > 0);
        if (logins.length > 0) params.authorLogins = logins;
      }
      return runRoute(
        Effect.gen(function* () {
          const prService = yield* PullRequestService;
          const { accountId } = ctx.account;
          return yield* prService.listArchivedPrs(accountId, params);
        }),
      );
    },
    {
      query: t.Object({
        cursor: t.Optional(t.String()),
        authors: t.Optional(t.String()),
      }),
    },
  );

/** The user's own actions across all their accounts: syncs and pins. A pinned PR must be theirs. */
const prUserRoutes = new Elysia({ prefix: "/api/prs" })
  .use(withAuth)
  .onBeforeHandle(ownedBy({ prId: "pull request" }))
  // Full sync of every repo. Forked, not awaited: a cold-start cycle also runs
  // the hourly metadata refresh and the archive backfill (up to 150 detail
  // fetches per repo), which is minutes of work — far too long to hold an HTTP
  // request open. Completion reaches the client over SSE (`prs:sync-complete`),
  // which is what it already listens for. A click while a cycle runs queues one
  // follow-up cycle that reuses its listings; more clicks join that one.
  .post("/sync", (ctx) =>
    runRoute(
      Effect.flatMap(PollScheduler, (s) => Effect.forkDetach(s.syncNow(ctx.userId))).pipe(
        Effect.as({ success: true }),
      ),
    ),
  )

  // Background freshness check, sent by the client when the window opens or
  // comes back to the foreground: the DB list it just painted can be a full
  // poll interval old. Same cycle as `/sync`, forked for the same reason, but
  // throttled server-side and never forcing a broadcast. An unchanged account
  // costs one GraphQL probe (about a point per 80 repos) and nothing on the wire.
  .post("/freshen", () =>
    runRoute(
      Effect.flatMap(PollScheduler, (s) => Effect.forkDetach(s.freshen())).pipe(
        Effect.as({ success: true }),
      ),
    ),
  )

  .get("/pinned", (ctx) =>
    runRoute(
      Effect.flatMap(DbService, ({ db }) =>
        dbTry("list pinned PRs", () =>
          db
            .select({ prId: pinnedPullRequests.prId })
            .from(pinnedPullRequests)
            .where(eq(pinnedPullRequests.userId, ctx.userId))
            .orderBy(pinnedPullRequests.createdAt)
            .all(),
        ),
      ).pipe(Effect.map((rows) => rows.map((r) => r.prId))),
    ),
  )

  .post(
    "/pinned",
    (ctx) =>
      runRoute(
        Effect.flatMap(DbService, ({ db }) =>
          dbTry("pin PR", () =>
            db.insert(pinnedPullRequests).values({ userId: ctx.userId, prId: ctx.body.prId }).run(),
          ),
        ).pipe(Effect.as({ success: true })),
      ),
    { body: t.Object({ prId: t.String() }) },
  )

  .delete("/pinned/:prId", (ctx) =>
    runRoute(
      Effect.flatMap(DbService, ({ db }) =>
        dbTry("unpin PR", () =>
          db
            .delete(pinnedPullRequests)
            .where(
              and(
                eq(pinnedPullRequests.userId, ctx.userId),
                eq(pinnedPullRequests.prId, ctx.params.prId),
              ),
            )
            .run(),
        ),
      ).pipe(Effect.as({ success: true })),
    ),
  );

/** One PR's routes, acting as the account that owns its repository. */
const prByIdRoutes = new Elysia({ prefix: "/api/prs" })
  .use(withAuth)
  .onBeforeHandle(ownedBy({ id: "pull request" }))
  .get("/:id", (ctx) =>
    runRoute(Effect.flatMap(PullRequestService, (prs) => prs.getPr(ctx.params.id))),
  )
  .get(
    "/:id/files",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const prContext = yield* PrContextService;
          const reviewService = yield* ReviewService;
          const github = yield* GitHubGateway;
          const diffCache = yield* DiffCacheService;
          const { pr, repo, client } = yield* prContext.forPr(ctx.params.id);

          // Unscoped (or scoped to head) means the full PR diff (merge-base
          // 3-dot, matching GitHub's "Files changed" tab) served from the
          // `pr_diff_files` cache. `?at=<sha>` scopes the review to the PR as
          // of that commit via a `base...at` compare, which is three-dot too
          // and returns the same fields in the same hunks-only patch format.
          // Ranged results never reach `pr_diff_files`: its PK `(prId, path)`
          // has no range dimension and `cacheFiles` wipes the PR's rows.
          const atSha = resolveScopedSha(ctx.query.at, pr.headSha);
          const files =
            atSha === null || pr.baseSha === null
              ? (yield* diffCache.getOrFetch(pr, repo.fullName, client)).files
              : toCachedDiffFiles(
                  yield* github.prs.compareFiles(client, repo.fullName, pr.baseSha, atSha),
                );
          const threads = yield* reviewService.threadsForPr(pr.id);
          return yield* Effect.promise(() =>
            prFilesWithPrerender(files, threads, ctx.query.active),
          );
        }),
      ),
    {
      query: t.Object({
        active: t.Optional(t.String()),
        at: t.Optional(t.String({ pattern: "^[0-9a-fA-F]{7,40}$" })),
      }),
      detail: {
        description: `Returns PR files and server-renders at most one diff, capped at ${SSR_PATCH_BYTE_LIMIT} bytes / ${SSR_PATCH_LINE_LIMIT} lines.`,
      },
    },
  )
  .get(
    "/:id/repo-file",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const prService = yield* PullRequestService;
          const repoCloneService = yield* RepoCloneService;

          // Every state is an answer the file peek shows, not a refusal.
          const pr = yield* prService.getPr(ctx.params.id);
          if (!pr.headSha) {
            return {
              status: "error" as const,
              message: "PR has no head SHA",
            };
          }

          const result = yield* repoCloneService.getFileContentAtSha(
            pr.repositoryId,
            pr.headSha,
            ctx.query.path,
          );

          if (result.status === "cloning") return { status: "cloning" as const };
          if (result.status === "not-found") return { status: "not-found" as const };
          if (result.status === "too-large") {
            return { status: "too-large" as const, size: result.size };
          }
          if (result.status === "error") {
            return { status: "error" as const, message: result.message };
          }

          return {
            status: "ready" as const,
            headSha: pr.headSha,
            path: ctx.query.path,
            content: result.content,
            isBinary: result.isBinary,
            size: result.size,
          };
        }),
      ),
    { query: t.Object({ path: t.String() }) },
  )
  .get(
    "/:id/file-blob",
    async (ctx) => {
      // Stream raw file bytes at the PR's base or head SHA for the
      // image-diff viewer. The local clone is `--depth=1` against the
      // default branch, so a PR's head SHA blob isn't guaranteed to
      // exist locally (added files in particular). Fetching via
      // GitHub's contents API with `Accept: application/vnd.github.raw`
      // sidesteps that — it works for any ref + path the user can see.
      return runRoute(
        Effect.gen(function* () {
          const prContext = yield* PrContextService;
          const github = yield* GitHubGateway;
          const { pr, repo, client } = yield* prContext.forPr(ctx.params.id);
          const sha = ctx.query.side === "base" ? pr.baseSha : pr.headSha;
          if (!sha) {
            return new Response("PR is missing the requested SHA", { status: 404 });
          }

          const bytes = yield* github.files.rawBytes(client, repo.fullName, ctx.query.path, sha);

          const contentType = guessImageContentType(ctx.query.path);
          // Bun types `bytes` as `Uint8Array<ArrayBufferLike>`, narrower than the
          // lib.dom BlobPart signature; we allocated its ArrayBuffer ourselves.
          const blob = new Blob([bytes as BlobPart], { type: contentType });
          return new Response(blob, {
            status: 200,
            headers: {
              "Content-Type": contentType,
              "Content-Length": String(bytes.byteLength),
              // Strong cache: (sha, path) is immutable per PR row.
              "Cache-Control": "private, max-age=31536000, immutable",
            },
          });
        }),
      );
    },
    {
      query: t.Object({
        path: t.String(),
        side: t.Union([t.Literal("base"), t.Literal("head")]),
      }),
    },
  )
  .get("/:id/suggestions", (ctx) =>
    runRoute(suggestionsForPr(ctx.params.id).pipe(Effect.map((suggestions) => ({ suggestions })))),
  )

  // Targeted refresh of a single PR. Bounded to a couple of GitHub requests, so
  // unlike `/sync` it is awaited and reports failure directly. Prefer this
  // wherever the user is asking about one PR rather than the whole list.
  .post("/:id/refresh", (ctx) =>
    runRoute(
      Effect.flatMap(PollScheduler, (s) => s.refreshPr(ctx.params.id)).pipe(
        Effect.as({ success: true }),
      ),
    ),
  )

  .get("/:id/commits", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const prContext = yield* PrContextService;
        const github = yield* GitHubGateway;
        const { pr, repo, client } = yield* prContext.forPr(ctx.params.id);
        return yield* github.prs.commits(client, repo.fullName, pr.externalId);
      }),
    ),
  )

  .post("/:id/sync-threads", (ctx) =>
    runRoute(
      Effect.flatMap(SyncService, (s) => s.syncThreadsNow(ctx.params.id)).pipe(
        Effect.as({ success: true }),
      ),
    ),
  )

  .post("/:id/convert-to-draft", (ctx) =>
    runRoute(mutatePr(ctx.params.id, "convert-to-draft").pipe(Effect.as({ success: true }))),
  )
  .post("/:id/ready-for-review", (ctx) =>
    runRoute(mutatePr(ctx.params.id, "ready-for-review").pipe(Effect.as({ success: true }))),
  )
  .post("/:id/close", (ctx) =>
    runRoute(mutatePr(ctx.params.id, "close").pipe(Effect.as({ success: true }))),
  )

  .get("/:id/merge-eligibility", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const prContext = yield* PrContextService;
        const { pr, repo, client } = yield* prContext.forPr(ctx.params.id);
        return yield* checkMergeEligibility(
          { prId: pr.id, repoFullName: repo.fullName, prNumber: pr.externalId },
          client,
        );
      }),
    ),
  )

  .post(
    "/:id/merge",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const prContext = yield* PrContextService;
          const github = yield* GitHubGateway;
          const mirror = yield* PrMirror;
          const { pr, repo, client } = yield* prContext.forPr(ctx.params.id);
          yield* github.prs.merge(client, repo.fullName, pr.externalId, ctx.body.mergeMethod);
          yield* mirror.recordMutation(pr.id, {
            kind: "terminal",
            status: "merged",
            closedAt: new Date().toISOString(),
          });
        }).pipe(Effect.as({ success: true })),
      ),
    {
      body: t.Object({
        mergeMethod: literalUnion(MERGE_METHODS),
      }),
    },
  );

export const prRoutes = new Elysia().use(prListRoutes).use(prUserRoutes).use(prByIdRoutes);

type PrMutationAction = "convert-to-draft" | "ready-for-review" | "close";

/** Run a PR mutation on GitHub as the repo's account, and record its outcome. */
function mutatePr(prId: string, action: PrMutationAction) {
  return Effect.gen(function* () {
    const prContext = yield* PrContextService;
    const github = yield* GitHubGateway;
    const mirror = yield* PrMirror;
    const { pr, repo, client } = yield* prContext.forPr(prId);

    if (action === "close") {
      yield* github.prs.close(client, repo.fullName, pr.externalId);
      yield* mirror.recordMutation(pr.id, {
        kind: "terminal",
        status: "closed",
        closedAt: new Date().toISOString(),
      });
      return;
    }
    const isDraft = action === "convert-to-draft";
    yield* (isDraft ? github.prs.convertToDraft : github.prs.markReadyForReview)(
      client,
      repo.fullName,
      pr.externalId,
    );
    yield* mirror.recordMutation(pr.id, { kind: "draft", isDraft });
  });
}
