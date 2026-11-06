import type { DiffLineAnnotation } from "@pierre/diffs";
import {
  buildGitPatchHeader,
  CHAT_SUGGESTION_FALLBACKS,
  type CommentThread,
  guessImageContentType,
  PR_DIFF_RENDER_OPTIONS,
} from "@revv/shared";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { resolveAgentLaunch } from "../ai/acp/agent-launch";
import {
  generateSuggestions,
  type SuggestionsWalkthroughContext,
} from "../ai/providers/suggestions";
import { pinnedPullRequests } from "../db/schema";
import { tryDb } from "../effects/db-try";
import { logError } from "../logger";
import { type CachedDiffFile, DiffCacheService, toCachedDiffFiles } from "../services/DiffCache";
import { GitHubGateway } from "../services/github/gateway";
import { checkMergeEligibility } from "../services/merge-eligibility";
import { PollScheduler } from "../services/PollScheduler";
import { PrContextService } from "../services/PrContext";
import {
  prerenderDiff,
  SSR_PATCH_BYTE_LIMIT,
  SSR_PATCH_LINE_LIMIT,
  type SsrDiffOptions,
} from "../services/PrerenderCache";
import { PrMirror } from "../services/PrMirror";
import { PullRequestService } from "../services/PullRequest";
import { resolvePullRequestLink } from "../services/pr-deep-link";
import { RepoCloneService } from "../services/RepoClone";
import { RepositoryService } from "../services/Repository";
import { ReviewService } from "../services/Review";
import { WalkthroughService } from "../services/Walkthrough";
import { runRoute, withAccount } from "./middleware";
import { ownedBy } from "./ownership";

// ── PR diff SSR options ─────────────────────────────────────────────────────
//
// Must match the structural options in DiffViewerInner.svelte:326-345 so the
// hydrated DOM lines up with what the client would have rendered. Callbacks
// and DOM-producing options stay client-side; only the layout-affecting
// fields are mirrored here.

const PR_DIFF_SSR_OPTIONS: SsrDiffOptions = PR_DIFF_RENDER_OPTIONS;

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

/** Build the full git patch the SSR call expects from a cached PR file row. */
function buildPrFilePatch(file: CachedDiffFile): string {
  const header = buildGitPatchHeader({
    path: file.path,
    oldPath: file.oldPath,
    isNew: file.status === "added",
    isDeleted: file.status === "removed",
  });
  return file.patch !== null ? `${header}\n${file.patch}` : header;
}

/**
 * SSR a single PR file, returning the prerendered HTML or undefined if the
 * file has no patch (binary), exceeds the SSR guardrails, or rendering
 * failed. The client always has a working render-path fallback.
 */
function annotationsForFile(
  filePath: string,
  threads: CommentThread[],
): DiffLineAnnotation<unknown>[] {
  return threads
    .filter((thread) => thread.filePath === filePath)
    .map((thread) => ({
      side: thread.diffSide === "old" ? "deletions" : "additions",
      lineNumber: thread.startLine,
      metadata: null,
    }));
}

async function prerenderPrFile(
  file: CachedDiffFile,
  threads: CommentThread[],
): Promise<string | undefined> {
  if (file.patch === null) return undefined;
  try {
    const annotations = annotationsForFile(file.path, threads);
    const html = await prerenderDiff(buildPrFilePatch(file), PR_DIFF_SSR_OPTIONS, annotations);
    return html ?? undefined;
  } catch (err) {
    logError("pr-files-prerender", `prerender failed for ${file.path}:`, err);
    return undefined;
  }
}

function selectPrerenderPath(files: CachedDiffFile[], activePath?: string): string | null {
  if (activePath !== undefined && files.some((file) => file.path === activePath)) {
    return activePath;
  }
  return files[0]?.path ?? null;
}

// ── Routes ───────────────────────────────────────────────────────────────────

export const prRoutes = new Elysia({ prefix: "/api/prs" })
  .use(withAccount)
  .onBeforeHandle(ownedBy({ id: "pull request", prId: "pull request" }))
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
      const expectedHost = ctx.body.githubHost.toLowerCase();
      const activeHost = ctx.account.host.toLowerCase();

      // This branch must stay before AppRuntime/service access. A mismatched
      // account is a recovery state, not permission to probe another
      // account's database rows or GitHub token.
      if (activeHost !== expectedHost) {
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
              findCachedPullRequest: (id) =>
                pullRequestService.getPr(id, accountId).pipe(Effect.option),
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
      const params: {
        repoId?: string;
        since?: string;
        until?: string;
        cursor?: string;
        limit?: number;
        authorLogins?: string[];
      } = {};
      if (ctx.query.repo !== undefined) params.repoId = ctx.query.repo;
      if (ctx.query.since !== undefined) params.since = ctx.query.since;
      if (ctx.query.until !== undefined) params.until = ctx.query.until;
      if (ctx.query.cursor !== undefined) params.cursor = ctx.query.cursor;
      if (ctx.query.limit !== undefined) {
        const n = Number(ctx.query.limit);
        if (Number.isFinite(n) && n > 0) params.limit = Math.floor(n);
      }
      if (ctx.query.authors !== undefined) {
        // Comma-separated author logins. GitHub logins never contain commas,
        // so a plain split is safe. Empty segments (e.g. trailing comma) are
        // dropped so an all-empty value behaves as "no author filter".
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
        repo: t.Optional(t.String()),
        since: t.Optional(t.String()),
        until: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        authors: t.Optional(t.String()),
      }),
    },
  )
  .get("/:id", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const prService = yield* PullRequestService;
        const { accountId } = ctx.account;
        return yield* prService.getPr(ctx.params.id, accountId);
      }),
    ),
  )
  .get(
    "/:id/files",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const prService = yield* PullRequestService;
          const repoService = yield* RepositoryService;
          const reviewService = yield* ReviewService;
          const github = yield* GitHubGateway;
          const diffCache = yield* DiffCacheService;
          const { accountId } = ctx.account;

          const pr = yield* prService.getPr(ctx.params.id, accountId);
          const repo = yield* repoService.getRepoById(pr.repositoryId, accountId);

          // Unscoped (or scoped to head) means the full PR diff (merge-base
          // 3-dot, matching GitHub's "Files changed" tab) served from the
          // `pr_diff_files` cache. `?at=<sha>` scopes the review to the PR as
          // of that commit via a `base...at` compare, which is three-dot too
          // and returns the same fields in the same hunks-only patch format.
          // Ranged results deliberately never reach `pr_diff_files`: its PK
          // `(prId, path)` has no range dimension and `cacheFiles` wipes the
          // PR's rows, so caching them would poison the full-PR view.
          const atSha = resolveScopedSha(ctx.query.at, pr.headSha);
          const files =
            atSha === null || pr.baseSha === null
              ? (yield* diffCache.getOrFetch(pr, repo.fullName, ctx.account.client)).files
              : toCachedDiffFiles(
                  yield* github.prs.compareFiles(
                    ctx.account.client,
                    repo.fullName,
                    pr.baseSha,
                    atSha,
                  ),
                );
          const threads = yield* reviewService.threadsForPr(pr.id);

          // SSR only the first visible file. Shiki tokenization is synchronous CPU
          // work, so rendering every file before returning makes cold /files calls
          // scale with total PR size. Oversized patches skip SSR entirely and use
          // the client renderer instead.
          const prerenderPath = selectPrerenderPath(files, ctx.query.active);
          return yield* Effect.promise(() =>
            Promise.all(
              files.map(async (f) => {
                const prerenderedHtml =
                  f.path === prerenderPath ? await prerenderPrFile(f, threads) : undefined;
                return {
                  path: f.path,
                  oldPath: f.oldPath,
                  patch: f.patch,
                  additions: f.additions,
                  deletions: f.deletions,
                  isNew: f.status === "added",
                  isDeleted: f.status === "removed",
                  ...(prerenderedHtml ? { prerenderedHtml } : {}),
                };
              }),
            ),
          );
        }),
      ),
    {
      query: t.Object({
        active: t.Optional(t.String()),
        // Malformed SHAs are rejected with a 400 before the handler runs, so
        // the compare path can only ever be reached with a plausible ref.
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
          const { accountId } = ctx.account;

          // Every state is an answer the file peek shows, not a refusal.
          const pr = yield* prService.getPr(ctx.params.id, accountId);
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
          const prService = yield* PullRequestService;
          const repoService = yield* RepositoryService;
          const { accountId, client } = ctx.account;
          const github = yield* GitHubGateway;

          const pr = yield* prService.getPr(ctx.params.id, accountId);
          const side = ctx.query.side;
          const sha = side === "base" ? pr.baseSha : pr.headSha;
          if (!sha) {
            return new Response("PR is missing the requested SHA", { status: 404 });
          }

          const repo = yield* repoService.getRepoById(pr.repositoryId, accountId);

          const bytes = yield* github.files.rawBytes(client, repo.fullName, ctx.query.path, sha);

          const contentType = guessImageContentType(ctx.query.path);
          // Bun typings on `bytes` are `Uint8Array<ArrayBufferLike>`,
          // narrower than the lib.dom BlobPart signature
          // (`ArrayBufferView<ArrayBuffer>`). The cast is safe — we
          // allocate the underlying ArrayBuffer ourselves via
          // `new Uint8Array(arrayBuffer)`. Wrapping in a Blob avoids
          // the BodyInit mismatch the raw Uint8Array hits.
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
    runRoute(
      resolveSuggestionsForPr(ctx.params.id, ctx.account.accountId).pipe(
        Effect.map((suggestions) => ({ suggestions })),
      ),
    ),
  )

  // Full sync of every repo. Forked, not awaited: a cold-start cycle also runs
  // the hourly metadata refresh and the archive backfill (up to 150 detail
  // fetches per repo), which is minutes of work — far too long to hold an HTTP
  // request open. Completion reaches the client over SSE (`prs:sync-complete`),
  // which is what it already listens for. `syncNow` coalesces, so a double-click
  // does not start a second pass.
  .post("/sync", () =>
    runRoute(
      Effect.flatMap(PollScheduler, (s) => Effect.forkDetach(s.syncNow())).pipe(
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

  // Targeted refresh of a single PR. Bounded to a couple of GitHub requests, so
  // unlike `/sync` it is awaited and reports failure directly. Prefer this
  // wherever the user is asking about one PR rather than the whole list.
  .post("/:id/refresh", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const prService = yield* PullRequestService;
        const scheduler = yield* PollScheduler;
        // Scoped to the account before it touches GitHub.
        yield* prService.getPr(ctx.params.id, ctx.account.accountId);
        yield* scheduler.refreshPr(ctx.params.id);
        return { success: true };
      }),
    ),
  )

  .get("/:id/commits", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const prService = yield* PullRequestService;
        const repoService = yield* RepositoryService;
        const { accountId, client } = ctx.account;
        const githubService = yield* GitHubGateway;

        const pr = yield* prService.getPr(ctx.params.id, accountId);
        const repo = yield* repoService.getRepoById(pr.repositoryId, accountId);

        return yield* githubService.prs.commits(client, repo.fullName, pr.externalId);
      }),
    ),
  )

  .post("/:id/sync-threads", (ctx) =>
    runRoute(
      Effect.flatMap(PollScheduler, (s) => s.syncThreadsNow(ctx.params.id)).pipe(
        Effect.as({ success: true }),
      ),
    ),
  )

  // ── Owner-only PR mutations (draft toggle, close) ─────────────────────
  //
  // All three endpoints follow the same shape: resolve PR + repo + token,
  // run the GitHub mutation, record its outcome on the local row, and
  // broadcast `prs:updated` so other clients see the new state without
  // waiting for the next poll cycle.
  .post("/:id/convert-to-draft", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const { accountId } = ctx.account;
        yield* mutatePr(ctx.params.id, accountId, "convert-to-draft");
      }).pipe(Effect.as({ success: true })),
    ),
  )
  .post("/:id/ready-for-review", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const { accountId } = ctx.account;
        yield* mutatePr(ctx.params.id, accountId, "ready-for-review");
      }).pipe(Effect.as({ success: true })),
    ),
  )
  .post("/:id/close", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const { accountId } = ctx.account;
        yield* mutatePr(ctx.params.id, accountId, "close");
      }).pipe(Effect.as({ success: true })),
    ),
  )

  .get("/:id/merge-eligibility", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const prContext = yield* PrContextService;
        const { pr, repo, client } = yield* prContext.forPr(ctx.params.id, ctx.account.accountId);
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
          const { accountId } = ctx.account;
          const prContext = yield* PrContextService;
          const github = yield* GitHubGateway;
          const mirror = yield* PrMirror;
          const { pr, repo, client } = yield* prContext.forPr(ctx.params.id, accountId);
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
        mergeMethod: t.Union([t.Literal("merge"), t.Literal("squash"), t.Literal("rebase")]),
      }),
    },
  )

  .get("/pinned", (ctx) =>
    runRoute(
      tryDb("list pinned PRs", (db) =>
        db
          .select({ prId: pinnedPullRequests.prId })
          .from(pinnedPullRequests)
          .where(eq(pinnedPullRequests.userId, ctx.session.user.id))
          .orderBy(pinnedPullRequests.createdAt)
          .all(),
      ).pipe(Effect.map((rows) => rows.map((r) => r.prId))),
    ),
  )

  .post(
    "/pinned",
    (ctx) =>
      runRoute(
        tryDb("pin PR", (db) =>
          db
            .insert(pinnedPullRequests)
            .values({ userId: ctx.session.user.id, prId: ctx.body.prId })
            .run(),
        ).pipe(Effect.as({ success: true })),
      ),
    { body: t.Object({ prId: t.String() }) },
  )

  .delete("/pinned/:prId", (ctx) =>
    runRoute(
      tryDb("unpin PR", (db) =>
        db
          .delete(pinnedPullRequests)
          .where(
            and(
              eq(pinnedPullRequests.userId, ctx.session.user.id),
              eq(pinnedPullRequests.prId, ctx.params.prId),
            ),
          )
          .run(),
      ).pipe(Effect.as({ success: true })),
    ),
  );

// ── Suggestions cache + resolver ─────────────────────────────────────────────
//
// In-memory cache for the right-panel suggestions endpoint. Keyed on
// `${prId}:${headSha}:${agent}:${model}` so any of those changing produces a
// fresh model call. TTL is soft — entries are cleaned up lazily on read.
//
// Compliant with CLAUDE.md invariant #1 (SQLite is authoritative): the cache
// is reconstructible. Any miss re-derives by loading the PR + walkthrough
// from DB and calling the model. The cache only exists to avoid re-spending
// tokens when the user opens the same PR repeatedly within one server
// session.
//
// Not invalidated server-side on settings change — the client invalidates
// its store, and the next request lands on a different `model` key, so the
// stale entry simply expires unused.

interface SuggestionsCacheEntry {
  readonly suggestions: string[];
  readonly expiresAt: number;
}

const SUGGESTIONS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SUGGESTIONS_CACHE_MAX_ENTRIES = 256;
const suggestionsCache = new Map<string, SuggestionsCacheEntry>();

function suggestionsCacheKey(prId: string, headSha: string, agent: string, model: string): string {
  return `${prId}:${headSha}:${agent}:${model}`;
}

function readSuggestionsCache(key: string): string[] | null {
  const entry = suggestionsCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    suggestionsCache.delete(key);
    return null;
  }
  return entry.suggestions;
}

function writeSuggestionsCache(key: string, suggestions: string[]): void {
  // Bounded eviction: drop the oldest insertion when we hit the cap. Map
  // preserves insertion order so deleting via `keys().next()` is O(1).
  if (suggestionsCache.size >= SUGGESTIONS_CACHE_MAX_ENTRIES) {
    const oldest = suggestionsCache.keys().next().value;
    if (oldest !== undefined) suggestionsCache.delete(oldest);
  }
  suggestionsCache.set(key, {
    suggestions,
    expiresAt: Date.now() + SUGGESTIONS_CACHE_TTL_MS,
  });
}

function resolveSuggestionsForPr(prId: string, accountId: string) {
  return Effect.gen(function* () {
    const prService = yield* PullRequestService;
    const walkthroughSvc = yield* WalkthroughService;
    const diffCache = yield* DiffCacheService;

    const launch = yield* resolveAgentLaunch("suggestions");
    if (!launch) return [...CHAT_SUGGESTION_FALLBACKS];

    const pr = yield* prService.getPr(prId, accountId);
    const headSha = pr.headSha ?? "no-head";

    // Cache check before any DB / model work.
    const key = suggestionsCacheKey(prId, headSha, launch.agent, launch.model);
    const cached = readSuggestionsCache(key);
    if (cached !== null) return cached;

    // Walkthrough context (best-effort) — only available when a
    // walkthrough has reached `status='complete'` for the current head
    // SHA. Without it we still produce PR-metadata-only suggestions.
    let walkthroughContext: SuggestionsWalkthroughContext | null = null;
    if (pr.headSha) {
      const walkthrough = yield* walkthroughSvc.getCached(prId, pr.headSha);
      if (walkthrough) {
        walkthroughContext = {
          summary: walkthrough.summary,
          riskLevel: walkthrough.riskLevel,
          sentiment: walkthrough.sentiment ?? null,
          issues: walkthrough.issues.map((i) => ({
            severity: i.severity,
            title: i.title,
            description: i.description,
            filePath: i.filePath ?? null,
          })),
        };
      }
    }

    // Diff files (best-effort, cache-only) — we explicitly do NOT
    // hit GitHub here. If the diff isn't cached yet (e.g., the user
    // just opened this PR for the first time), we still produce
    // suggestions from title/body/walkthrough alone.
    const cachedFiles = yield* diffCache.getCachedFiles(prId);
    const changedFiles = (cachedFiles ?? []).map((f) => f.path);

    const suggestions = yield* Effect.tryPromise({
      try: () =>
        generateSuggestions({
          prTitle: pr.title,
          prBody: pr.body,
          changedFiles,
          additions: pr.additions,
          deletions: pr.deletions,
          walkthrough: walkthroughContext,
          launch,
        }),
      // Provider has its own internal fallback; this catch is
      // belt-and-suspenders for the rare case where the Promise
      // rejects despite the provider's try/catch.
      catch: () => null as null,
    }).pipe(
      Effect.catch(() => Effect.succeed([...CHAT_SUGGESTION_FALLBACKS] as string[])),
      Effect.map((v) => (v === null ? [...CHAT_SUGGESTION_FALLBACKS] : v)),
    );

    writeSuggestionsCache(key, suggestions);
    return suggestions;
  });
}

type PrMutationAction = "convert-to-draft" | "ready-for-review" | "close";

/** Run a PR mutation on GitHub as the repo's account, and record its outcome. */
function mutatePr(prId: string, accountId: string, action: PrMutationAction) {
  return Effect.gen(function* () {
    const prContext = yield* PrContextService;
    const github = yield* GitHubGateway;
    const mirror = yield* PrMirror;
    const { pr, repo, client } = yield* prContext.forPr(prId, accountId);

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
