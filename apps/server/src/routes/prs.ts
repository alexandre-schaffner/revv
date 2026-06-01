import type { DiffLineAnnotation } from "@pierre/diffs";
import { type CommentThread, guessImageContentType } from "@revv/shared";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import {
  FALLBACK_PROMPTS,
  generateSuggestions,
  type SuggestionsWalkthroughContext,
} from "../ai/providers/suggestions";
import { db } from "../auth";
import { pinnedPullRequests, user } from "../db/schema";
import { logError } from "../logger";
import { AppRuntime } from "../runtime";
import { Broadcaster } from "../services/Broadcaster";
import { type CachedDiffFile, DiffCacheService, getOrFetchDiffFiles } from "../services/DiffCache";
import { GitHubGateway } from "../services/GitHub";
import { OpencodeSupervisor } from "../services/OpencodeSupervisor";
import { PollScheduler } from "../services/PollScheduler";
import { PrContextService } from "../services/PrContext";
import { prerenderDiff, type SsrDiffOptions } from "../services/PrerenderCache";
import { PullRequestService } from "../services/PullRequest";
import { RepoCloneService } from "../services/RepoClone";
import { RepositoryService } from "../services/Repository";
import { ReviewService } from "../services/Review";
import { SettingsService } from "../services/Settings";
import { SyncService } from "../services/Sync";
import { WalkthroughService } from "../services/Walkthrough";
import { handleAppError, withAccount } from "./middleware";

// ── PR diff SSR options ─────────────────────────────────────────────────────
//
// Must match the structural options in DiffViewerInner.svelte:326-345 so the
// hydrated DOM lines up with what the client would have rendered. Callbacks
// and DOM-producing options stay client-side; only the layout-affecting
// fields are mirrored here.

const PR_DIFF_SSR_OPTIONS: SsrDiffOptions = {
  diffStyle: "unified",
  theme: { dark: "pierre-dark", light: "pierre-light" },
  overflow: "scroll",
  expansionLineCount: 20,
  collapsedContextThreshold: 3,
  diffIndicators: "bars",
  expandUnchanged: true,
  lineHoverHighlight: "both",
  hunkSeparators: "line-info",
};

/** Build the full git patch the SSR call expects from a cached PR file row. */
function buildPrFilePatch(file: CachedDiffFile): string {
  const header = [
    `diff --git a/${file.oldPath ?? file.path} b/${file.path}`,
    ...(file.status === "added" ? ["new file mode 100644"] : []),
    ...(file.status === "removed" ? ["deleted file mode 100644"] : []),
    `--- ${file.status === "added" ? "/dev/null" : `a/${file.oldPath ?? file.path}`}`,
    `+++ ${file.status === "removed" ? "/dev/null" : `b/${file.path}`}`,
  ].join("\n");
  return file.patch !== null ? `${header}\n${file.patch}` : header;
}

/**
 * SSR a single PR file, returning the prerendered HTML or undefined if the
 * file has no patch (binary) or rendering failed. No size cap — the user's
 * "no wait on file switch" UX hinges on every file in the PR being
 * prerendered. First-visit cost is paid once per PR head sha (LRU-cached);
 * subsequent /files calls hit the cache. Failures only log — the client
 * always has a working render-path fallback.
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

// ── Routes ───────────────────────────────────────────────────────────────────

export const prRoutes = new Elysia({ prefix: "/api/prs" })
  .use(withAccount)
  .get(
    "/",
    async (ctx) => {
      try {
        const repoId = ctx.query.repo;
        return await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prService = yield* PullRequestService;
            const { accountId } = ctx.account;
            return yield* prService.listPrs(accountId, repoId);
          }),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { query: t.Object({ repo: t.Optional(t.String()) }) },
  )
  .get(
    "/archived",
    async (ctx) => {
      try {
        const params: {
          repoId?: string;
          since?: string;
          until?: string;
          cursor?: string;
          limit?: number;
        } = {};
        if (ctx.query.repo !== undefined) params.repoId = ctx.query.repo;
        if (ctx.query.since !== undefined) params.since = ctx.query.since;
        if (ctx.query.until !== undefined) params.until = ctx.query.until;
        if (ctx.query.cursor !== undefined) params.cursor = ctx.query.cursor;
        if (ctx.query.limit !== undefined) {
          const n = Number(ctx.query.limit);
          if (Number.isFinite(n) && n > 0) params.limit = Math.floor(n);
        }
        return await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prService = yield* PullRequestService;
            const { accountId } = ctx.account;
            return yield* prService.listArchivedPrs(accountId, params);
          }),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      query: t.Object({
        repo: t.Optional(t.String()),
        since: t.Optional(t.String()),
        until: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )
  .get("/:id", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.gen(function* () {
          const prService = yield* PullRequestService;
          const { accountId } = ctx.account;
          return yield* prService.getPr(ctx.params.id, accountId);
        }),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .get(
    "/tagged",
    async (ctx) => {
      try {
        const repoId = ctx.query.repo;
        if (!repoId) {
          ctx.set.status = 400;
          return { error: "repo query parameter is required" };
        }
        // Look up the current user's GitHub login.
        const rows = await db
          .select({ githubLogin: user.githubLogin })
          .from(user)
          .where(eq(user.id, ctx.session.user.id));
        const login = rows[0]?.githubLogin;
        if (!login) {
          return [];
        }
        return await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prService = yield* PullRequestService;
            const { accountId } = ctx.account;
            return yield* prService.listTaggedPrs(repoId, login, accountId);
          }),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { query: t.Object({ repo: t.String() }) },
  )
  .get("/:id/files", async (ctx) => {
    try {
      const { files, threads } = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const prService = yield* PullRequestService;
          const repoService = yield* RepositoryService;
          const reviewService = yield* ReviewService;
          const { accountId, accessToken: token } = ctx.account;

          const pr = yield* prService.getPr(ctx.params.id, accountId);
          const repo = yield* repoService.getRepoById(pr.repositoryId, accountId);

          // Always the full PR diff (merge-base 3-dot, matching GitHub's
          // "Files changed" tab). No per-commit selection anymore — the
          // commits dropdown is read-only.
          const files = yield* getOrFetchDiffFiles(pr.id, repo.fullName, pr.externalId, token);
          const session = yield* reviewService.getActiveSession(pr.id);
          const threads = session ? yield* reviewService.getThreadsForSession(session.id) : [];
          return { files, threads };
        }),
      );

      // SSR each file in parallel — Bun's JS thread interleaves the awaits,
      // and Shiki's shared highlighter is already warm (preloaded at boot).
      // Cache hits skip work entirely; misses are bounded by SSR_PATCH_BYTE_LIMIT.
      return await Promise.all(
        files.map(async (f) => ({
          path: f.path,
          oldPath: f.oldPath,
          patch: f.patch,
          additions: f.additions,
          deletions: f.deletions,
          isNew: f.status === "added",
          isDeleted: f.status === "removed",
          prerenderedHtml: await prerenderPrFile(f, threads),
        })),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .get(
    "/:id/repo-file",
    async (ctx) => {
      try {
        return await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prService = yield* PullRequestService;
            const repoCloneService = yield* RepoCloneService;
            const { accountId } = ctx.account;

            const pr = yield* prService.getPr(ctx.params.id, accountId);
            if (!pr.headSha) {
              ctx.set.status = 404;
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

            if (result.status === "cloning") {
              ctx.set.status = 202;
              return { status: "cloning" as const };
            }
            if (result.status === "not-found") {
              ctx.set.status = 404;
              return { status: "not-found" as const };
            }
            if (result.status === "too-large") {
              // 413 Payload Too Large — surfaces a distinct
              // frontend state ("file too large to preview")
              // without conflating with cloning/missing.
              ctx.set.status = 413;
              return {
                status: "too-large" as const,
                size: result.size,
              };
            }
            if (result.status === "error") {
              ctx.set.status = 409;
              return {
                status: "error" as const,
                message: result.message,
              };
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
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { query: t.Object({ path: t.String() }) },
  )
  .get(
    "/:id/file-blob",
    async (ctx) => {
      try {
        // Stream raw file bytes at the PR's base or head SHA for the
        // image-diff viewer. The local clone is `--depth=1` against the
        // default branch, so a PR's head SHA blob isn't guaranteed to
        // exist locally (added files in particular). Fetching via
        // GitHub's contents API with `Accept: application/vnd.github.raw`
        // sidesteps that — it works for any ref + path the user can see.
        return await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prService = yield* PullRequestService;
            const repoService = yield* RepositoryService;
            const { accountId, accessToken: token } = ctx.account;
            const github = yield* GitHubGateway;

            const pr = yield* prService.getPr(ctx.params.id, accountId);
            const side = ctx.query.side;
            const sha = side === "base" ? pr.baseSha : pr.headSha;
            if (!sha) {
              return new Response("PR is missing the requested SHA", { status: 404 });
            }

            const repo = yield* repoService.getRepoById(pr.repositoryId, accountId);

            const bytes = yield* github.files.rawBytes(repo.fullName, ctx.query.path, sha, token);

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
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      query: t.Object({
        path: t.String(),
        side: t.Union([t.Literal("base"), t.Literal("head")]),
      }),
    },
  )
  .get("/:id/suggestions", async (ctx) => {
    try {
      const suggestions = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const { accountId } = ctx.account;
          return yield* resolveSuggestionsForPr(ctx.params.id, accountId);
        }),
      );
      return { suggestions };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  .post("/sync", async (ctx) => {
    try {
      await AppRuntime.runPromise(Effect.flatMap(PollScheduler, (s) => s.syncNow()));

      return { success: true };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  .get("/:id/commits", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.gen(function* () {
          const prService = yield* PullRequestService;
          const repoService = yield* RepositoryService;
          const { accountId, accessToken: token } = ctx.account;
          const githubService = yield* GitHubGateway;

          const pr = yield* prService.getPr(ctx.params.id, accountId);
          const repo = yield* repoService.getRepoById(pr.repositoryId, accountId);

          return yield* githubService.prs.commits(repo.fullName, pr.externalId, token);
        }),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  .post("/:id/sync-threads", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(SyncService, (s) => s.syncThreads(ctx.params.id)),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  .get("/:id/thread-summary", async (ctx) => {
    try {
      // Look up the current user's GitHub login for role-aware counts.
      const rows = await db
        .select({ githubLogin: user.githubLogin })
        .from(user)
        .where(eq(user.id, ctx.session.user.id));
      const login = rows[0]?.githubLogin ?? null;

      return await AppRuntime.runPromise(
        Effect.flatMap(SyncService, (s) => s.getThreadSummary(ctx.params.id, login)),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  // ── Owner-only PR mutations (draft toggle, close) ─────────────────────
  //
  // All three endpoints follow the same shape: resolve PR + repo + token,
  // run the GitHub mutation, refresh the local row from a fresh GET, and
  // broadcast `prs:updated` so other clients see the new state without
  // waiting for the next poll cycle.
  .post("/:id/convert-to-draft", async (ctx) => {
    try {
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const { accountId } = ctx.account;
          yield* mutatePr(ctx.params.id, ctx.session.user.id, accountId, "convert-to-draft");
        }),
      );
      return { success: true };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .post("/:id/ready-for-review", async (ctx) => {
    try {
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const { accountId } = ctx.account;
          yield* mutatePr(ctx.params.id, ctx.session.user.id, accountId, "ready-for-review");
        }),
      );
      return { success: true };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .post("/:id/close", async (ctx) => {
    try {
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const { accountId } = ctx.account;
          yield* mutatePr(ctx.params.id, ctx.session.user.id, accountId, "close");
        }),
      );
      return { success: true };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  .get("/:id/merge-eligibility", async (ctx) => {
    try {
      const eligibility = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const prContext = yield* PrContextService;
          const github = yield* GitHubGateway;
          const { pr, repo, token } = yield* prContext.resolveBasic(
            ctx.params.id,
            ctx.session.user.id,
          );
          return yield* github.prs.mergeEligibility(repo.fullName, pr.externalId, token);
        }),
      );
      return eligibility;
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  .post(
    "/:id/merge",
    async (ctx) => {
      try {
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const { accountId } = ctx.account;
            const prContext = yield* PrContextService;
            const github = yield* GitHubGateway;
            const prService = yield* PullRequestService;
            const broadcaster = yield* Broadcaster;
            const { pr, repo, token } = yield* prContext.resolveBasic(
              ctx.params.id,
              ctx.session.user.id,
            );
            const mergeMethod = (ctx.body?.mergeMethod ??
              "merge") as import("@revv/shared").MergeMethod;
            yield* github.prs.merge(repo.fullName, pr.externalId, mergeMethod, token);
            // The merge succeeded, so we know the PR is merged. Do not trust
            // github.getPr here — it goes through the ETag cache and can return
            // the stale pre-merge body because the merge PUT and the PR GET are
            // different cache keys. Construct the updated row locally instead.
            const now = new Date().toISOString();
            const refreshed = {
              ...pr,
              status: "merged" as const,
              closedAt: now,
              updatedAt: now,
              fetchedAt: now,
            };
            yield* prService.upsertPrs([refreshed]);
            const all = yield* prService.listPrs(accountId);
            yield* broadcaster.broadcastToAccount(accountId, { type: "prs:updated", data: all });
          }),
        );
        return { success: true };
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      body: t.Object({
        mergeMethod: t.Union([t.Literal("merge"), t.Literal("squash"), t.Literal("rebase")]),
      }),
    },
  )

  .get("/pinned", async (ctx) => {
    try {
      const rows = await db
        .select({ prId: pinnedPullRequests.prId })
        .from(pinnedPullRequests)
        .where(eq(pinnedPullRequests.userId, ctx.session.user.id))
        .orderBy(pinnedPullRequests.createdAt);
      return rows.map((r) => r.prId);
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })

  .post(
    "/pinned",
    async (ctx) => {
      try {
        await db.insert(pinnedPullRequests).values({
          userId: ctx.session.user.id,
          prId: ctx.body.prId,
        });
        return { success: true };
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { body: t.Object({ prId: t.String() }) },
  )

  .delete("/pinned/:prId", async (ctx) => {
    try {
      await db
        .delete(pinnedPullRequests)
        .where(
          and(
            eq(pinnedPullRequests.userId, ctx.session.user.id),
            eq(pinnedPullRequests.prId, ctx.params.prId),
          ),
        );
      return { success: true };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  });

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
    const settingsSvc = yield* SettingsService;
    const prService = yield* PullRequestService;
    const walkthroughSvc = yield* WalkthroughService;
    const diffCache = yield* DiffCacheService;
    const supervisor = yield* OpencodeSupervisor;

    const settings = yield* settingsSvc.getSettings();
    const agent = yield* settingsSvc.resolveAgent();
    const model = settings.aiSuggestionsModel;
    if (!model || model.length === 0) {
      return [...FALLBACK_PROMPTS];
    }

    const pr = yield* prService.getPr(prId, accountId);
    const headSha = pr.headSha ?? "no-head";

    // Cache check before any DB / model work.
    const key = suggestionsCacheKey(prId, headSha, agent, model);
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

    // Build opencode deps lazily — the provider only consults them
    // when `agent === 'opencode'`. Using the same supervisor
    // instance that chat/walkthrough share keeps the daemon
    // single-tenant.
    const opencodeDeps =
      agent === "opencode"
        ? {
            ensureDaemon: () => Effect.runPromise(supervisor.ensureRunning()),
            client: () => Effect.runPromise(supervisor.client()),
          }
        : undefined;

    const suggestions = yield* Effect.tryPromise({
      try: () =>
        generateSuggestions({
          prTitle: pr.title,
          prBody: pr.body,
          changedFiles,
          additions: pr.additions,
          deletions: pr.deletions,
          walkthrough: walkthroughContext,
          agent,
          model,
          ...(opencodeDeps !== undefined ? { opencodeDeps } : {}),
        }),
      // Provider has its own internal fallback; this catch is
      // belt-and-suspenders for the rare case where the Promise
      // rejects despite the provider's try/catch.
      catch: () => null as null,
    }).pipe(
      Effect.catchAll(() => Effect.succeed([...FALLBACK_PROMPTS] as string[])),
      Effect.map((v) => (v === null ? [...FALLBACK_PROMPTS] : v)),
    );

    writeSuggestionsCache(key, suggestions);
    return suggestions;
  });
}

type PrMutationAction = "convert-to-draft" | "ready-for-review" | "close";

/**
 * Shared executor for the three owner-only PR mutations above. Each one is
 * a thin wrapper over a single GitHubGateway call, so the
 * resolve → mutate → refresh-row → broadcast scaffolding is identical and
 * lifted here.
 */
function mutatePr(prId: string, userId: string, accountId: string, action: PrMutationAction) {
  return Effect.gen(function* () {
    const prContext = yield* PrContextService;
    const github = yield* GitHubGateway;
    const prService = yield* PullRequestService;
    const broadcaster = yield* Broadcaster;

    const { pr, repo, token } = yield* prContext.resolveBasic(prId, userId);

    if (action === "convert-to-draft") {
      yield* github.prs.convertToDraft(repo.fullName, pr.externalId, token);
    } else if (action === "ready-for-review") {
      yield* github.prs.markReadyForReview(repo.fullName, pr.externalId, token);
    } else {
      yield* github.prs.close(repo.fullName, pr.externalId, token);
    }

    // Refresh from a fresh GET so isDraft / status reflect GitHub's new
    // state — the mutation responses don't return the full PR shape we
    // store, and the conditional cache would otherwise replay the
    // pre-mutation body on the next read.
    const refreshed = yield* github.prs
      .get(repo.fullName, pr.externalId, token)
      .pipe(Effect.map((p) => ({ ...p, id: pr.id, repositoryId: pr.repositoryId })));
    yield* prService.upsertPrs([refreshed]);

    const all = yield* prService.listPrs(accountId);
    yield* broadcaster.broadcastToAccount(accountId, { type: "prs:updated", data: all });
  });
}
