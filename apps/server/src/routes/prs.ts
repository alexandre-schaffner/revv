import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import {
  FALLBACK_PROMPTS,
  generateSuggestions,
  type SuggestionsWalkthroughContext,
} from "../ai/providers/suggestions";
import { db } from "../auth";
import { user } from "../db/schema";
import { AppRuntime } from "../runtime";
import { resolveAgent } from "../services/Ai";
import { DiffCacheService, getOrFetchDiffFiles } from "../services/DiffCache";
import { GitHubService } from "../services/GitHub";
import { OpencodeSupervisor } from "../services/OpencodeSupervisor";
import { PollScheduler } from "../services/PollScheduler";
import { PrContextService } from "../services/PrContext";
import { PullRequestService } from "../services/PullRequest";
import { RepoCloneService } from "../services/RepoClone";
import { RepositoryService } from "../services/Repository";
import { SettingsService } from "../services/Settings";
import { SyncService } from "../services/Sync";
import { TokenProvider } from "../services/TokenProvider";
import { WalkthroughService } from "../services/Walkthrough";
import { WebSocketHub } from "../services/WebSocketHub";
import { handleAppError, withAuth } from "./middleware";

// ── Routes ───────────────────────────────────────────────────────────────────

export const prRoutes = new Elysia({ prefix: "/api/prs" })
  .use(withAuth)
  .get(
    "/",
    async (ctx) => {
      try {
        const repoId = ctx.query.repo;
        return await AppRuntime.runPromise(
          Effect.flatMap(PullRequestService, (s) => s.listPrs(repoId)),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { query: t.Object({ repo: t.Optional(t.String()) }) },
  )
  .get("/archived", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(PullRequestService, (s) => s.listArchivedPrs()),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .get("/:id", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(PullRequestService, (s) => s.getPr(ctx.params.id)),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .get("/:id/files", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.gen(function* () {
          const prService = yield* PullRequestService;
          const repoService = yield* RepositoryService;
          const tokenProvider = yield* TokenProvider;

          const pr = yield* prService.getPr(ctx.params.id);
          const repo = yield* repoService.getRepoById(pr.repositoryId);

          // Always the full PR diff (merge-base 3-dot, matching GitHub's
          // "Files changed" tab). No per-commit selection anymore — the
          // commits dropdown is read-only.
          const token = yield* tokenProvider.getGitHubToken(ctx.session.user.id, repo.githubHost);
          const files = yield* getOrFetchDiffFiles(pr.id, repo.fullName, pr.externalId, token);

          return files.map((f) => ({
            path: f.path,
            oldPath: f.oldPath,
            patch: f.patch,
            additions: f.additions,
            deletions: f.deletions,
            isNew: f.status === "added",
            isDeleted: f.status === "removed",
          }));
        }),
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

            const pr = yield* prService.getPr(ctx.params.id);
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
  .get("/:id/suggestions", async (ctx) => {
    try {
      const suggestions = await AppRuntime.runPromise(resolveSuggestionsForPr(ctx.params.id));
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
          const tokenProvider = yield* TokenProvider;
          const githubService = yield* GitHubService;

          const pr = yield* prService.getPr(ctx.params.id);
          const repo = yield* repoService.getRepoById(pr.repositoryId);
          const token = yield* tokenProvider.getGitHubToken(ctx.session.user.id, repo.githubHost);

          return yield* githubService.listPrCommits(repo.fullName, pr.externalId, token);
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
      await AppRuntime.runPromise(mutatePr(ctx.params.id, ctx.session.user.id, "convert-to-draft"));
      return { success: true };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .post("/:id/ready-for-review", async (ctx) => {
    try {
      await AppRuntime.runPromise(mutatePr(ctx.params.id, ctx.session.user.id, "ready-for-review"));
      return { success: true };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .post("/:id/close", async (ctx) => {
    try {
      await AppRuntime.runPromise(mutatePr(ctx.params.id, ctx.session.user.id, "close"));
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

function resolveSuggestionsForPr(prId: string) {
  return Effect.gen(function* () {
    const settingsSvc = yield* SettingsService;
    const prService = yield* PullRequestService;
    const walkthroughSvc = yield* WalkthroughService;
    const diffCache = yield* DiffCacheService;
    const supervisor = yield* OpencodeSupervisor;

    const settings = yield* settingsSvc.getSettings();
    const agent = resolveAgent(settings);
    const model = settings.aiSuggestionsModel;
    if (!model || model.length === 0) {
      return [...FALLBACK_PROMPTS];
    }

    const pr = yield* prService.getPr(prId);
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
 * a thin wrapper over a single GitHubService call, so the
 * resolve → mutate → refresh-row → broadcast scaffolding is identical and
 * lifted here.
 */
function mutatePr(prId: string, userId: string, action: PrMutationAction) {
  return Effect.gen(function* () {
    const prContext = yield* PrContextService;
    const github = yield* GitHubService;
    const prService = yield* PullRequestService;
    const hub = yield* WebSocketHub;

    const { pr, repo, token } = yield* prContext.resolveBasic(prId, userId);

    if (action === "convert-to-draft") {
      yield* github.convertPrToDraft(repo.fullName, pr.externalId, token);
    } else if (action === "ready-for-review") {
      yield* github.markPrReadyForReview(repo.fullName, pr.externalId, token);
    } else {
      yield* github.closePullRequest(repo.fullName, pr.externalId, token);
    }

    // Refresh from a fresh GET so isDraft / status reflect GitHub's new
    // state — the mutation responses don't return the full PR shape we
    // store, and the conditional cache would otherwise replay the
    // pre-mutation body on the next read.
    const refreshed = yield* github
      .getPr(repo.fullName, pr.externalId, token)
      .pipe(Effect.map((p) => ({ ...p, id: pr.id, repositoryId: pr.repositoryId })));
    yield* prService.upsertPrs([refreshed]);

    const all = yield* prService.listPrs();
    yield* hub.broadcast({ type: "prs:updated", data: all });
  });
}
