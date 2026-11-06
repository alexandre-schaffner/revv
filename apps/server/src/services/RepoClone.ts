import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CloneStatus, Repository } from "@revv/shared";
import { and, eq, or } from "drizzle-orm";
import { Context, Effect, Layer, type Scope } from "effect";
import { pullRequests, repositories, walkthroughs } from "../db/schema/index";
import { CloneError, CloneNotReadyError } from "../domain/errors";
import { debug, logError } from "../logger";
import {
  assertSafeManagedClonePath,
  CLONE_BASE_DIR,
  decideCloneDestination,
  existingPathIsUnder,
  expandUserPath,
  findWorktreesOnBranch,
  parseRemoteFullName,
  pathIsUnder,
  readCloneDestinationState,
  remoteMatches,
  worktreeHolderPath,
} from "./clone-policy";
import { DbService } from "./Db";
import {
  abortMerge,
  abortRebase,
  addWorktreeOnBranch,
  attachedBranch,
  blobContent,
  blobSize,
  commitExists,
  deleteBranch,
  deleteRef,
  fetch,
  gitDirs,
  isAncestor,
  isGitRepo,
  isMergeInProgress,
  isRebaseInProgress,
  listRefs,
  listWorktrees,
  proposedCommitCount,
  reapOrphanedGitProcesses,
  remotes,
  removeWorktree,
  resetHard,
  resolveRef,
  shallowClone,
  updateRef,
} from "./git/ops";
import {
  agentBranch,
  agentWorktreeDir,
  legacyPrRef,
  prFetchRef,
  REVV_REF_NAMESPACES,
  reviewWorktreeId,
  scratchWorktreeDir,
} from "./git/pr-refs";
import { authedRemoteUrl, cloneSource } from "./git/remote";
import { clearScratch, prepareScratch } from "./git/scratch";
import { GitHubAccounts } from "./github/accounts";
import { Realtime } from "./Realtime";

const CLONE_TIMEOUT_MS = 600_000;

/** Files larger than this get a "too large to preview" placeholder instead of their content. */
const MAX_FILE_CONTENT_BYTES = 5 * 1024 * 1024;

/** A NUL in this many leading bytes marks a file binary, as `git diff` decides it. */
const BINARY_SNIFF_SAMPLE_BYTES = 8 * 1024;

// ── Service definition ────────────────────────────────────────────────────────

/**
 * Result of a single-PR worktree reap. `pruned:false` means the teardown was
 * intentionally skipped to avoid destroying live or unsaved work — the caller
 * can surface `reason` (e.g. "you have N reviews with unpushed changes").
 */
export type PruneWorktreeOutcome =
  | { readonly pruned: true }
  | {
      readonly pruned: false;
      readonly reason: "unpushed-commits" | "not-found";
    };

export class RepoCloneService extends Context.Service<
  RepoCloneService,
  {
    /** Start a shallow clone for a repo. Updates DB status. Fire-and-forget via Effect.fork. */
    readonly cloneRepo: (
      repo: Repository,
      githubToken: string,
      accountId: string,
      opts?: { readonly basePath?: string },
    ) => Effect.Effect<void, CloneError>;
    readonly linkExisting: (
      repo: Repository,
      localPath: string,
      accountId: string,
    ) => Effect.Effect<void, CloneError>;
    readonly inspectLocal: (
      localPath: string,
      gitHost: string,
    ) => Effect.Effect<
      {
        readonly isGitRepo: boolean;
        readonly proposedFullName: string | null;
        readonly remotes: ReadonlyArray<{ readonly name: string; readonly url: string }>;
      },
      CloneError
    >;
    /**
     * Read a file's content at a given commit SHA from the local clone.
     * Used by the sidebar's "view unchanged file" path — the user clicked
     * a file in the repo tree that isn't part of the PR's diff and we
     * want to surface its contents in the main pane anyway.
     *
     * Behavior:
     *   - Refuses files larger than {@link MAX_FILE_CONTENT_BYTES}
     *     ('too-large' return) so we never blow up the UI on a giant
     *     binary or source-bundle blob.
     *   - Detects binary content by sampling the first 8 KB for null
     *     bytes; binaries return with empty `content` and
     *     `isBinary: true` so the frontend can render a placeholder
     *     instead of garbage.
     *   - Otherwise returns the full UTF-8 content as a string.
     *
     * The clone is assumed ready — if the user reached this code path,
     * the tree was already listed, which gates on `cloneStatus`. We
     * still report `cloning` for symmetry in case the repo flipped
     * back to pending/cloning between calls.
     */
    readonly getFileContentAtSha: (
      repoId: string,
      headSha: string,
      path: string,
    ) => Effect.Effect<
      | {
          readonly status: "ready";
          readonly content: string;
          readonly isBinary: boolean;
          readonly size: number;
        }
      | { readonly status: "cloning" }
      | { readonly status: "not-found" }
      | { readonly status: "too-large"; readonly size: number }
      | { readonly status: "error"; readonly message: string },
      CloneError
    >;
    /** Get the clone status for a repo. */
    readonly getCloneStatus: (repoId: string) => Effect.Effect<{
      status: CloneStatus;
      path: string | null;
      error: string | null;
    }>;
    /** Delete clone directory and reset DB fields. */
    readonly deleteClone: (repoId: string) => Effect.Effect<void, CloneError>;
    /** Resume any repos with cloneStatus 'pending' or 'error' by re-triggering cloneRepo. */
    readonly resumePendingClones: () => Effect.Effect<void>;
    /**
     * The PR's agent worktree, `<holder>/pr-N` on the agent branch `revv/pr-N`,
     * at `prHeadSha` or a descendant of it (the agent's unpushed commits).
     * Created on first use and kept until the PR is pruned or the repo
     * removed. Only `PrWorkspace` calls this, under its claim on the PR.
     *
     * An existing worktree on the branch at a descendant of `prHeadSha` is
     * returned untouched; one at another commit is reset to `prHeadSha`; one
     * on the wrong branch or broken is removed and recreated.
     */
    readonly acquirePrWorktree: (params: {
      readonly repoId: string;
      readonly prNumber: number;
      readonly prHeadSha: string;
      readonly githubToken: string;
    }) => Effect.Effect<
      { readonly worktreePath: string; readonly branchName: string },
      CloneError | CloneNotReadyError
    >;
    /**
     * A detached worktree at `headSha` for one walkthrough generation,
     * removed when the scope closes (CLAUDE.md invariant 10). Its path is
     * keyed on the walkthrough, so a resumed run clears what a killed one
     * left, and `sweepStaleWorktrees` removes those of runs that never resume.
     */
    readonly acquireReviewWorktree: (params: {
      readonly repoId: string;
      readonly prNumber: number;
      readonly headSha: string;
      readonly githubToken: string;
      readonly walkthroughId: string;
    }) => Effect.Effect<string, CloneError | CloneNotReadyError, Scope.Scope>;
    /**
     * Reap one PR's agent worktree, its branch and its fetch refs. Refuses
     * (`pruned: false`) while the branch carries commits beyond the recorded
     * PR head, unless `force`. Callers decide which PRs are eligible.
     */
    readonly pruneWorktree: (params: {
      readonly repoId: string;
      readonly prNumber: number;
      readonly force?: boolean;
    }) => Effect.Effect<PruneWorktreeOutcome, CloneError>;
    /**
     * Sweep every ready repo for agent branches whose PR is closed, merged or
     * no longer tracked, reaping them via {@link pruneWorktree}, and for review
     * worktrees of walkthroughs no longer generating. Best-effort.
     */
    readonly sweepStaleWorktrees: () => Effect.Effect<
      { readonly scanned: number; readonly pruned: number; readonly keptUnpushed: number },
      CloneError
    >;
  }
>()("RepoCloneService") {}

/**
 * Lock files tied to one PR's worktree and its branch ref. A git command the
 * agent was running when its subprocess was killed can leave them behind, and
 * every later fetch or reset then fails with "Unable to create '…': File
 * exists". Repository-wide locks (packed-refs, shallow) are left alone: another
 * PR's job may legitimately hold them.
 */
async function prWorktreeLockPaths(worktreePath: string, branchName: string): Promise<string[]> {
  const dirs = await gitDirs(worktreePath);
  if (!dirs) return [];
  return [
    join(dirs.gitDir, "index.lock"),
    join(dirs.gitDir, "HEAD.lock"),
    join(dirs.commonDir, "refs", "heads", `${branchName}.lock`),
  ];
}

async function clearStalePrWorktreeLocks(worktreePath: string, branchName: string): Promise<void> {
  for (const lockPath of await prWorktreeLockPaths(worktreePath, branchName)) {
    try {
      if (!existsSync(lockPath)) continue;
      await rm(lockPath, { force: true });
      debug("pr-worktree", "cleared stale git lock:", lockPath);
    } catch (err) {
      logError(
        "pr-worktree",
        "failed to clear stale lock:",
        lockPath,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Whether an existing PR worktree can be reused as-is, answered with reads
 * only. `acquirePrWorktree` runs on every chat turn and composer warm-up, and
 * its repair path writes under `.git`, which fires a file-watcher event in any
 * editor that has the user's repository open. Only an unhealthy worktree should
 * pay that.
 *
 * Healthy: the directory exists, no lock files, no merge or rebase in
 * progress, no legacy `refs/revv/pr-N` shadowing the branch, HEAD on the agent
 * branch at `prHeadSha` or a descendant of it.
 */
export async function isWorktreeHealthy(params: {
  clonePath: string;
  branchName: string;
  worktreePath: string;
  prHeadSha: string;
  prNumber: number;
}): Promise<boolean> {
  const { clonePath, branchName, worktreePath, prHeadSha, prNumber } = params;
  if (!existsSync(worktreePath)) return false;
  if ((await isMergeInProgress(worktreePath)) || (await isRebaseInProgress(worktreePath))) {
    return false;
  }
  const locks = await prWorktreeLockPaths(worktreePath, branchName);
  if (locks.length === 0 || locks.some((lockPath) => existsSync(lockPath))) return false;
  if ((await resolveRef(clonePath, legacyPrRef(prNumber))) !== null) return false;
  if ((await attachedBranch(worktreePath)) !== `refs/heads/${branchName}`) return false;
  const currentSha = await resolveRef(worktreePath, "HEAD");
  if (currentSha === null) return false;
  return currentSha === prHeadSha || isAncestor(worktreePath, prHeadSha, currentSha);
}

/**
 * Make `prHeadSha` present in the object store, fetching it if needed.
 *
 * The SHA itself is fetched first: GitHub serves any commit reachable from
 * any of its refs (`uploadpack.allowReachableSHA1InWant`), which includes
 * commits force-pushed away from a PR for about 90 days. A GitHub Enterprise
 * that disables that gets the PR's current head ref instead, which only helps
 * when `prHeadSha` still is that head.
 */
async function ensurePrCommitPresent(
  cwd: string,
  prHeadSha: string,
  prNumber: number,
  url: string,
): Promise<void> {
  if (await commitExists(cwd, prHeadSha)) return;
  const direct = await fetch(cwd, url, [prHeadSha]);
  if (direct.ok && (await commitExists(cwd, prHeadSha))) return;
  if (!direct.ok) {
    debug(
      "pr-worktree",
      `direct SHA fetch failed for ${prHeadSha}, falling back to PR ref:`,
      direct.stderr,
    );
  }
  const viaRef = await fetch(cwd, url, [`refs/pull/${prNumber}/head`]);
  if (!viaRef.ok) {
    throw new Error(
      [
        `Unable to fetch PR #${prNumber} head commit ${prHeadSha}.`,
        "GitHub did not provide the direct commit or refs/pull head ref.",
        "The PR may have been force-pushed, deleted, moved, or the local PR metadata may be stale.",
        `Direct SHA fetch: ${direct.stderr}`,
        `PR ref fetch: ${viaRef.stderr}`,
      ].join(" "),
    );
  }
  if (!(await commitExists(cwd, prHeadSha))) {
    throw new Error(
      `commit ${prHeadSha} is not available on origin — it may have been force-pushed away or garbage-collected by GitHub`,
    );
  }
}

const toCloneError = (err: unknown) =>
  err instanceof CloneError
    ? err
    : new CloneError({ message: err instanceof Error ? err.message : String(err), cause: err });

// ── Live implementation ───────────────────────────────────────────────────────

export const RepoCloneServiceLive = Layer.effect(
  RepoCloneService,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const realtime = yield* Realtime;
    const accounts = yield* GitHubAccounts;

    yield* Effect.promise(() => reapOrphanedGitProcesses());

    // Startup recovery: reset any repos that were mid-clone when server restarted
    db.update(repositories)
      .set({
        cloneStatus: "pending",
        cloneError: "Server restarted during clone",
      })
      .where(eq(repositories.cloneStatus, "cloning"))
      .run();

    // In-flight de-duplication. Keys are repo ids. Prevents the
    // startup-resume + manual POST + retry-clone routes from spawning
    // concurrent clones for the same repo. SQLite remains authoritative
    // for status; this set is a process-local short-circuit.
    const inFlightClones = new Set<string>();

    const readyRepo = (repoId: string) => {
      const row = db.select().from(repositories).where(eq(repositories.id, repoId)).get();
      if (row?.cloneStatus !== "ready" || !row.clonePath) throw new CloneNotReadyError({ repoId });
      return { ...row, clonePath: row.clonePath };
    };

    const cloneRepo = (
      repo: Repository,
      githubToken: string,
      accountId: string,
      opts?: { readonly basePath?: string },
    ): Effect.Effect<void, CloneError> =>
      Effect.suspend((): Effect.Effect<void, CloneError> => {
        // Short-circuit if a clone is already running for this repo in
        // this process. Returning success-void is correct: the in-flight
        // fiber will perform the DB update + WS broadcast for the caller.
        if (inFlightClones.has(repo.id)) {
          debug(
            "repo-clone",
            `clone already in flight for ${repo.fullName} (id=${repo.id}); skipping duplicate`,
          );
          return Effect.void;
        }
        inFlightClones.add(repo.id);

        return Effect.withSpan("RepoClone.cloneRepo", {
          attributes: { repoFullName: repo.fullName },
        })(
          Effect.gen(function* () {
            const cloneDir = opts?.basePath
              ? join(expandUserPath(opts.basePath), repo.owner, repo.name)
              : (repo.clonePath ?? join(CLONE_BASE_DIR, repo.owner, repo.name));
            const gitHost = repo.githubHost;
            const source = cloneSource({
              host: gitHost,
              fullName: repo.fullName,
              token: githubToken,
            });

            debug("repo-clone", `starting clone for ${repo.fullName} -> ${cloneDir}`);

            const cloneResult = yield* Effect.tryPromise({
              try: async () => {
                const state = await readCloneDestinationState(cloneDir, gitHost, repo.fullName);
                const decision = decideCloneDestination(
                  state,
                  pathIsUnder(cloneDir, CLONE_BASE_DIR),
                );

                if (decision.action === "fail") {
                  throw new Error(decision.message);
                }

                if (decision.action === "link") {
                  db.update(repositories)
                    .set({
                      managed: false,
                      cloneStatus: "ready",
                      clonePath: cloneDir,
                      cloneError: null,
                    })
                    .where(eq(repositories.id, repo.id))
                    .run();
                  return { mode: "linked" as const };
                }

                if (decision.action === "adopt") {
                  // A valid clone of this repo already exists inside the
                  // managed base — adopt it as managed without re-cloning.
                  db.update(repositories)
                    .set({
                      managed: true,
                      cloneStatus: "ready",
                      clonePath: cloneDir,
                      cloneError: null,
                    })
                    .where(eq(repositories.id, repo.id))
                    .run();
                  return { mode: "adopted" as const };
                }

                db.update(repositories)
                  .set({
                    managed: true,
                    cloneStatus: "cloning",
                    clonePath: cloneDir,
                    cloneError: null,
                  })
                  .where(eq(repositories.id, repo.id))
                  .run();

                mkdirSync(dirname(cloneDir), { recursive: true });

                if (decision.removeExisting && existsSync(cloneDir)) {
                  await rm(cloneDir, { recursive: true, force: true });
                }

                const cloned = await shallowClone(
                  source.url,
                  cloneDir,
                  source.authConfig,
                  CLONE_TIMEOUT_MS,
                );
                if (!cloned.ok) {
                  throw new Error(
                    cloned.timedOut
                      ? `git clone timed out after ${CLONE_TIMEOUT_MS / 1000}s; tail: ${cloned.stderr.slice(-512)}`
                      : `git clone failed: ${cloned.stderr}`,
                  );
                }

                return { mode: "managed" as const };
              },
              catch: (err) =>
                new CloneError({
                  message: err instanceof Error ? err.message : String(err),
                  cause: err,
                }),
            }).pipe(
              Effect.matchEffect({
                onSuccess: ({ mode }) =>
                  Effect.gen(function* () {
                    if (mode === "managed") {
                      db.update(repositories)
                        .set({ managed: true, cloneStatus: "ready" })
                        .where(eq(repositories.id, repo.id))
                        .run();
                    }

                    debug("repo-clone", `clone ready for ${repo.fullName} at ${cloneDir}`);

                    yield* realtime.toAccount(accountId, {
                      type: "repos:clone-status",
                      data: { repoId: repo.id, status: "ready" },
                    });
                  }),
                onFailure: (err) =>
                  Effect.gen(function* () {
                    // Clean up any partial clone directory only when Revv owns
                    // the default-base path. Custom-location failures may point
                    // at user content and must not be guessed away.
                    if (pathIsUnder(cloneDir, CLONE_BASE_DIR) && existsSync(cloneDir)) {
                      yield* Effect.tryPromise({
                        try: () => rm(cloneDir, { recursive: true, force: true }),
                        catch: () => undefined,
                      }).pipe(Effect.catch(() => Effect.void));
                    }

                    // Record the failure in DB then broadcast error
                    const errorMessage = err.message;
                    db.update(repositories)
                      .set({ cloneStatus: "error", cloneError: errorMessage })
                      .where(eq(repositories.id, repo.id))
                      .run();

                    // Always log clone failures. The route handlers attach
                    // `Effect.catchAll(() => Effect.void)` so without this
                    // line a clone failure is invisible in server logs —
                    // operators only see the silent DB row update and the
                    // best-effort WS broadcast (which is lost if the client
                    // happens to be disconnected at the moment of failure).
                    logError("repo-clone", `clone failed for ${repo.fullName}: ${errorMessage}`);

                    yield* realtime.toAccount(accountId, {
                      type: "repos:clone-status",
                      data: {
                        repoId: repo.id,
                        status: "error",
                        error: errorMessage,
                      },
                    });

                    return yield* Effect.fail(err);
                  }),
              }),
            );

            return cloneResult;
          }),
        ).pipe(
          // Always release the in-flight slot, regardless of success,
          // failure, or fiber interruption. Without this, a single
          // crash mid-clone would block any future clone attempt for
          // the same repo until the server restarts.
          Effect.ensuring(
            Effect.sync(() => {
              inFlightClones.delete(repo.id);
            }),
          ),
        );
      });

    const linkExisting = (
      repo: Repository,
      localPath: string,
      accountId: string,
    ): Effect.Effect<void, CloneError> =>
      Effect.tryPromise({
        try: async () => {
          // Record a link failure (DB + broadcast) and surface it. Linked
          // repos always stay `managed: false` so the deletion path never
          // `rm -rf`s a user-owned checkout.
          const failLink = async (error: string): Promise<never> => {
            db.update(repositories)
              .set({
                managed: false,
                cloneStatus: "error",
                clonePath: localPath,
                cloneError: error,
              })
              .where(eq(repositories.id, repo.id))
              .run();
            await realtime.toAccount(accountId, {
              type: "repos:clone-status",
              data: { repoId: repo.id, status: "error", error },
            });
            throw new Error(error);
          };

          const ready = existsSync(localPath) && (await isGitRepo(localPath));
          if (!ready) {
            await failLink("Linked clone not found — re-link");
          }

          // Verify the local checkout's origin actually points at the
          // GitHub repo identity we saved. The HTTP route validates
          // `fullName` against GitHub but never proves the *path* belongs
          // to it — and the link form lets the user edit the full name
          // after inspection. Without this guard, `owner/A` could be linked
          // to a clone of `owner/B`; later PR worktree creation would fetch
          // `owner/A` refs into the wrong clone and write `revv/pr-*`
          // branches there.
          const matches = await remoteMatches(localPath, repo.githubHost, repo.fullName);
          if (!matches) {
            await failLink(
              `Local clone's origin remote does not match ${repo.fullName} — choose the matching checkout`,
            );
          }

          db.update(repositories)
            .set({
              managed: false,
              cloneStatus: "ready",
              clonePath: localPath,
              cloneError: null,
            })
            .where(eq(repositories.id, repo.id))
            .run();
          await realtime.toAccount(accountId, {
            type: "repos:clone-status",
            data: { repoId: repo.id, status: "ready" },
          });
        },
        catch: (err) =>
          new CloneError({
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          }),
      });

    const pruneWorktree = ({
      repoId,
      prNumber,
      force = false,
    }: {
      repoId: string;
      prNumber: number;
      force?: boolean;
    }): Effect.Effect<PruneWorktreeOutcome, CloneError> =>
      Effect.tryPromise({
        try: async (): Promise<PruneWorktreeOutcome> => {
          const row = db.select().from(repositories).where(eq(repositories.id, repoId)).get();
          if (row?.cloneStatus !== "ready" || !row.clonePath) {
            return { pruned: false, reason: "not-found" };
          }
          const clonePath = row.clonePath;
          const branchName = agentBranch(prNumber);
          const worktreePath = join(
            worktreeHolderPath(row.owner, row.name),
            agentWorktreeDir(prNumber),
          );
          const worktreeExists = existsSync(worktreePath);

          if (!force) {
            const headSha =
              db
                .select({ headSha: pullRequests.headSha })
                .from(pullRequests)
                .where(
                  and(eq(pullRequests.repositoryId, repoId), eq(pullRequests.externalId, prNumber)),
                )
                .get()?.headSha ?? null;
            if (headSha) {
              const ahead = await proposedCommitCount(
                worktreeExists ? worktreePath : clonePath,
                `${headSha}..${branchName}`,
              );
              if ((ahead ?? 0) > 0) return { pruned: false, reason: "unpushed-commits" };
            }
          }

          await removeWorktree(clonePath, worktreePath);
          if (existsSync(worktreePath)) await rm(worktreePath, { recursive: true, force: true });
          await deleteBranch(clonePath, branchName);
          await deleteRef(clonePath, prFetchRef(prNumber));
          await deleteRef(clonePath, legacyPrRef(prNumber));
          return { pruned: true };
        },
        catch: toCloneError,
      });

    /** Review worktrees whose walkthrough is no longer generating: their run died and won't resume. */
    const sweepReviewWorktrees = async (clonePath: string, holder: string): Promise<void> => {
      for (const worktree of await listWorktrees(clonePath)) {
        if (dirname(worktree.path) !== holder) continue;
        const walkthroughId = reviewWorktreeId(basename(worktree.path));
        if (walkthroughId === null) continue;
        const generating = db
          .select({ id: walkthroughs.id })
          .from(walkthroughs)
          .where(and(eq(walkthroughs.id, walkthroughId), eq(walkthroughs.status, "generating")))
          .get();
        if (!generating) await clearScratch(clonePath, worktree.path);
      }
    };

    const sweepStaleWorktrees = (): Effect.Effect<
      { scanned: number; pruned: number; keptUnpushed: number },
      CloneError
    > =>
      Effect.gen(function* () {
        const repos = db
          .select()
          .from(repositories)
          .where(eq(repositories.cloneStatus, "ready"))
          .all();

        let scanned = 0;
        let pruned = 0;
        let keptUnpushed = 0;

        for (const repo of repos) {
          if (!repo.clonePath) continue;
          const clonePath = repo.clonePath;
          yield* Effect.promise(() =>
            sweepReviewWorktrees(clonePath, worktreeHolderPath(repo.owner, repo.name)),
          );

          // By branch, not by worktree: an agent branch whose worktree is
          // already gone still clutters the user's branch list.
          const prNumbers = (yield* Effect.promise(() => listRefs(clonePath, ["refs/heads/revv/"])))
            .map((ref) => /^refs\/heads\/revv\/pr-(\d+)$/.exec(ref)?.[1])
            .filter((n): n is string => Boolean(n))
            .map((n) => Number.parseInt(n, 10));

          for (const prNumber of prNumbers) {
            scanned++;
            const prRow = db
              .select({ status: pullRequests.status })
              .from(pullRequests)
              .where(
                and(eq(pullRequests.repositoryId, repo.id), eq(pullRequests.externalId, prNumber)),
              )
              .get();
            const terminal = !prRow || prRow.status === "closed" || prRow.status === "merged";
            if (!terminal) continue;

            const outcome = yield* pruneWorktree({ repoId: repo.id, prNumber }).pipe(
              Effect.catch(() =>
                Effect.succeed<PruneWorktreeOutcome>({ pruned: false, reason: "not-found" }),
              ),
            );
            if (outcome.pruned) pruned++;
            else if (outcome.reason === "unpushed-commits") keptUnpushed++;
          }
        }

        if (pruned > 0 || keptUnpushed > 0) {
          debug(
            "repo-clone",
            `worktree sweep: pruned ${pruned}, kept ${keptUnpushed} with unpushed commits (scanned ${scanned})`,
          );
        }

        return { scanned, pruned, keptUnpushed };
      });

    return {
      cloneRepo,
      pruneWorktree,
      sweepStaleWorktrees,
      linkExisting,

      inspectLocal: (localPath, gitHost) =>
        Effect.tryPromise({
          try: async () => {
            if (!(existsSync(localPath) && (await isGitRepo(localPath)))) {
              return { isGitRepo: false, proposedFullName: null, remotes: [] };
            }
            const found = await remotes(localPath);
            const origin = found.find((remote) => remote.name === "origin");
            const proposedFullName =
              (origin ? parseRemoteFullName(origin.url, gitHost) : null) ??
              found.map((remote) => parseRemoteFullName(remote.url, gitHost)).find(Boolean) ??
              null;
            return { isGitRepo: true, proposedFullName, remotes: found };
          },
          catch: toCloneError,
        }),

      acquirePrWorktree: ({ repoId, prNumber, prHeadSha, githubToken }) =>
        Effect.withSpan("RepoClone.acquirePrWorktree", {
          attributes: { repoId, prNumber, headSha: prHeadSha },
        })(
          Effect.tryPromise({
            try: async () => {
              const row = readyRepo(repoId);
              const clonePath = row.clonePath;
              const branchName = agentBranch(prNumber);
              const holder = worktreeHolderPath(row.owner, row.name);
              const worktreePath = join(holder, agentWorktreeDir(prNumber));

              if (
                await isWorktreeHealthy({
                  clonePath,
                  branchName,
                  worktreePath,
                  prHeadSha,
                  prNumber,
                })
              ) {
                return { worktreePath, branchName };
              }

              const url = authedRemoteUrl({
                host: row.githubHost,
                fullName: row.fullName,
                token: githubToken,
              });
              mkdirSync(holder, { recursive: true });
              if (existsSync(worktreePath))
                await clearStalePrWorktreeLocks(worktreePath, branchName);
              await deleteRef(clonePath, legacyPrRef(prNumber));

              // Leftovers of a push or branch edit that was killed mid-way.
              if (existsSync(worktreePath)) {
                await abortMerge(worktreePath);
                await abortRebase(worktreePath);
              }

              if (existsSync(worktreePath)) {
                if ((await attachedBranch(worktreePath)) === `refs/heads/${branchName}`) {
                  const currentSha = await resolveRef(worktreePath, "HEAD");
                  if (
                    currentSha !== null &&
                    (currentSha === prHeadSha ||
                      (await isAncestor(worktreePath, prHeadSha, currentSha)))
                  ) {
                    return { worktreePath, branchName };
                  }
                  await ensurePrCommitPresent(worktreePath, prHeadSha, prNumber, url);
                  const reset = await resetHard(worktreePath, prHeadSha);
                  if (!reset.ok) throw new Error(`git reset failed: ${reset.stderr}`);
                  return { worktreePath, branchName };
                }
                await removeWorktree(clonePath, worktreePath);
                await rm(worktreePath, { recursive: true, force: true });
              }
              // A registration whose directory is already gone would make `worktree add` fail.
              await removeWorktree(clonePath, worktreePath);

              // Reclaim the branch from Revv's own orphaned worktrees; the
              // user's worktrees live outside the holder and are left alone.
              for (const squatter of await findWorktreesOnBranch(clonePath, branchName)) {
                if (squatter === worktreePath) continue;
                if (!existingPathIsUnder(squatter, CLONE_BASE_DIR)) {
                  debug("pr-worktree", `leaving non-Revv squatter alone: ${squatter}`);
                  continue;
                }
                await removeWorktree(clonePath, squatter);
                try {
                  if (existsSync(squatter)) await rm(squatter, { recursive: true, force: true });
                } catch (err) {
                  logError(
                    "pr-worktree",
                    "failed to rm squatter dir:",
                    err instanceof Error ? err.message : String(err),
                  );
                }
              }

              await ensurePrCommitPresent(clonePath, prHeadSha, prNumber, url);
              const fetched = await updateRef(clonePath, prFetchRef(prNumber), prHeadSha);
              if (!fetched.ok) throw new Error(`git update-ref failed: ${fetched.stderr}`);
              const added = await addWorktreeOnBranch(
                clonePath,
                worktreePath,
                branchName,
                prHeadSha,
              );
              if (!added.ok) throw new Error(`git worktree add failed: ${added.stderr}`);
              return { worktreePath, branchName };
            },
            catch: (err) => (err instanceof CloneNotReadyError ? err : toCloneError(err)),
          }),
        ),

      acquireReviewWorktree: ({ repoId, prNumber, headSha, githubToken, walkthroughId }) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              const row = readyRepo(repoId);
              const holder = worktreeHolderPath(row.owner, row.name);
              const path = join(holder, scratchWorktreeDir.review(walkthroughId));
              mkdirSync(holder, { recursive: true });
              await ensurePrCommitPresent(
                row.clonePath,
                headSha,
                prNumber,
                authedRemoteUrl({
                  host: row.githubHost,
                  fullName: row.fullName,
                  token: githubToken,
                }),
              );
              const prepared = await prepareScratch(row.clonePath, path, headSha);
              if (prepared.kind === "failed") throw new Error(prepared.message);
              return { clonePath: row.clonePath, path };
            },
            catch: (err) => (err instanceof CloneNotReadyError ? err : toCloneError(err)),
          }),
          ({ clonePath, path }) =>
            Effect.promise(() =>
              clearScratch(clonePath, path).catch((err) =>
                logError("review-worktree", `couldn't remove ${path}:`, err),
              ),
            ),
        ).pipe(Effect.map(({ path }) => path)),

      getFileContentAtSha: (repoId: string, headSha: string, path: string) =>
        Effect.tryPromise({
          try: async () => {
            const row = db.select().from(repositories).where(eq(repositories.id, repoId)).get();

            if (!row) return { status: "cloning" } as const;

            if (row.cloneStatus === "pending" || row.cloneStatus === "cloning") {
              return { status: "cloning" } as const;
            }

            if (row.cloneStatus === "error") {
              return {
                status: "error",
                message: row.cloneError ?? "Clone failed",
              } as const;
            }

            const clonePath = row.clonePath;
            if (row.cloneStatus !== "ready" || !clonePath) {
              return { status: "cloning" } as const;
            }

            const size = await blobSize(clonePath, headSha, path);
            if (size === null) return { status: "not-found" } as const;
            if (size > MAX_FILE_CONTENT_BYTES) return { status: "too-large", size } as const;

            const content = await blobContent(clonePath, headSha, path);

            const sniffEnd = Math.min(content.length, BINARY_SNIFF_SAMPLE_BYTES);
            let isBinary = false;
            for (let i = 0; i < sniffEnd; i++) {
              if (content.charCodeAt(i) === 0) {
                isBinary = true;
                break;
              }
            }

            if (isBinary) {
              return {
                status: "ready",
                content: "",
                isBinary: true,
                size,
              } as const;
            }

            return {
              status: "ready",
              content,
              isBinary: false,
              size,
            } as const;
          },
          catch: (err) =>
            new CloneError({
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            }),
        }),

      getCloneStatus: (repoId: string) =>
        // DB queries are synchronous (better-sqlite3 driver) so this is infallible
        Effect.sync(() => {
          const row = db.select().from(repositories).where(eq(repositories.id, repoId)).get();

          return {
            status: (row?.cloneStatus ?? "pending") as CloneStatus,
            path: row?.clonePath ?? null,
            error: row?.cloneError ?? null,
          };
        }),

      deleteClone: (repoId: string) =>
        Effect.tryPromise({
          try: async () => {
            const row = db.select().from(repositories).where(eq(repositories.id, repoId)).get();

            if (row) {
              const holder = worktreeHolderPath(row.owner, row.name);
              const clonePath = row.clonePath && existsSync(row.clonePath) ? row.clonePath : null;
              if (clonePath) {
                for (const worktree of await listWorktrees(clonePath)) {
                  if (dirname(worktree.path) === holder)
                    await removeWorktree(clonePath, worktree.path);
                }
              }
              if (existsSync(holder)) await rm(holder, { recursive: true, force: true });

              if (row.clonePath && row.managed) {
                assertSafeManagedClonePath(row.clonePath);
                await rm(row.clonePath, { recursive: true, force: true });
              } else if (clonePath) {
                for (const ref of await listRefs(clonePath, ["refs/heads/revv/"])) {
                  const branch = ref.slice("refs/heads/".length);
                  if (/^revv\/pr-\d+$/.test(branch)) await deleteBranch(clonePath, branch);
                }
                for (const ref of await listRefs(clonePath, REVV_REF_NAMESPACES)) {
                  await deleteRef(clonePath, ref);
                }
              }
            }

            // Reset clone state in DB regardless of whether a dir existed
            db.update(repositories)
              .set({
                cloneStatus: "pending",
                clonePath: null,
                cloneError: null,
              })
              .where(eq(repositories.id, repoId))
              .run();
          },
          catch: (err) => {
            if (err instanceof CloneError) return err;
            return new CloneError({
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            });
          },
        }),

      resumePendingClones: () =>
        Effect.gen(function* () {
          const pendingRepos = db
            .select()
            .from(repositories)
            .where(
              and(
                eq(repositories.managed, true),
                or(eq(repositories.cloneStatus, "pending"), eq(repositories.cloneStatus, "error")),
              ),
            )
            .all();

          if (pendingRepos.length === 0) return;

          debug("repo-clone", `resuming ${pendingRepos.length} pending/error clone(s)`);

          for (const repo of pendingRepos) {
            const tokenOption = yield* accounts.clientFor(repo.accountId).pipe(
              Effect.map((client) => client.token),
              Effect.option,
            );

            if (tokenOption._tag === "None") {
              debug("repo-clone", `skipping repo ${repo.fullName} — no token available`);
              continue;
            }

            const repoRecord = {
              id: repo.id,
              provider: repo.provider,
              owner: repo.owner,
              name: repo.name,
              fullName: repo.fullName,
              defaultBranch: repo.defaultBranch,
              avatarUrl: repo.avatarUrl ?? null,
              addedAt: repo.addedAt,
              cloneStatus: repo.cloneStatus,
              clonePath: repo.clonePath ?? null,
              cloneError: repo.cloneError ?? null,
              managed: repo.managed,
              githubHost: repo.githubHost,
            };

            const token = tokenOption.value;
            yield* Effect.forkDetach(
              cloneRepo(repoRecord, token, repo.accountId).pipe(
                Effect.catch((err) => {
                  debug("repo-clone", `clone failed for ${repo.fullName}: ${err.message}`);
                  return Effect.void;
                }),
              ),
            );
          }
        }),
    };
  }),
);
