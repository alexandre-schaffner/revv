import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { CloneStatus, Repository } from "@revv/shared";
import { eq, or } from "drizzle-orm";
import { Context, Effect, Layer, type Scope } from "effect";
import { GITHUB_HOST } from "../auth";
import { serverEnv } from "../config";
import { CLONE_TIMEOUT_MS } from "../constants";
import { repositories } from "../db/schema/index";
import { CloneError, CloneNotReadyError } from "../domain/errors";
import { debug, logError } from "../logger";
import { DbService } from "./Db";
import { TokenProvider } from "./TokenProvider";
import { WebSocketHub } from "./WebSocketHub";

// ── Constants ─────────────────────────────────────────────────────────────────

const CLONE_BASE_DIR = serverEnv.cloneDir;

// ── Service definition ────────────────────────────────────────────────────────

export class RepoCloneService extends Context.Tag("RepoCloneService")<
  RepoCloneService,
  {
    /** Start a shallow clone for a repo. Updates DB status. Fire-and-forget via Effect.fork. */
    readonly cloneRepo: (
      repo: Repository,
      githubToken: string,
    ) => Effect.Effect<void, CloneError>;
    /** Fetch the PR ref and create/update a git worktree. Returns worktree path. */
    readonly ensurePrWorktree: (
      repoId: string,
      prNumber: number,
      githubToken: string,
    ) => Effect.Effect<string, CloneError | CloneNotReadyError>;
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
     * Acquire a dedicated git worktree pinned to `prHeadSha` for a single
     * walkthrough job. The worktree is created at
     * `{clonePath}/worktrees/walkthrough-{walkthroughId}` and registered as a
     * Scope finalizer — on scope close (success, failure, or interruption) the
     * worktree is removed via `git worktree remove --force`.
     *
     * This is *additive* to the shared per-PR worktree managed by
     * {@link ensurePrWorktree}. Concurrent jobs for the same PR at the same SHA
     * each get their own directory, so filesystem state can never leak.
     */
    readonly acquireWalkthroughWorktree: (
      repoId: string,
      walkthroughId: string,
      prHeadSha: string,
      githubToken: string,
      prNumber: number,
    ) => Effect.Effect<string, CloneError | CloneNotReadyError, Scope.Scope>;
  }
>() {}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Spawn a git command and wait for it, throwing if it exits non-zero or times out. */
async function runGit(
  args: string[],
  cwd?: string,
  timeoutMs = 120_000,
): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    ...(cwd !== undefined ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill();
      reject(new Error(`git ${args[0]} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs),
  );

  await Promise.race([proc.exited, timeoutPromise]);

  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
  }
}

/** Race a git clone against a timeout, killing the process if it exceeds the limit. */
async function runGitCloneWithTimeout(
  args: string[],
  timeoutMs: number,
): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill();
      reject(new Error(`git clone timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs),
  );

  await Promise.race([proc.exited, timeoutPromise]);

  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git clone failed: ${stderr.trim()}`);
  }
}

/** Validate that a path is safely within the expected clone base directory. */
function assertSafeClonePath(clonePath: string): void {
  if (!clonePath.startsWith(CLONE_BASE_DIR)) {
    throw new CloneError({
      message: `Refusing to delete path outside of clone base dir: ${clonePath}`,
    });
  }
}

// ── Live implementation ───────────────────────────────────────────────────────

export const RepoCloneServiceLive = Layer.effect(
  RepoCloneService,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const wsHub = yield* WebSocketHub;
    const tokenProvider = yield* TokenProvider;

    // Startup recovery: reset any repos that were mid-clone when server restarted
    db.update(repositories)
      .set({
        cloneStatus: "pending",
        cloneError: "Server restarted during clone",
      })
      .where(eq(repositories.cloneStatus, "cloning"))
      .run();

    const cloneRepo = (
      repo: Repository,
      githubToken: string,
    ): Effect.Effect<void, CloneError> =>
      Effect.gen(function* () {
        const cloneDir = join(CLONE_BASE_DIR, repo.owner, repo.name);
        const cloneUrl = `https://x-access-token:${githubToken}@${GITHUB_HOST}/${repo.fullName}.git`;

        // Mark as cloning in DB
        db.update(repositories)
          .set({
            cloneStatus: "cloning",
            clonePath: cloneDir,
            cloneError: null,
          })
          .where(eq(repositories.id, repo.id))
          .run();

        // Perform the git clone (pure async I/O — no Effect deps needed inside)
        const cloneResult = yield* Effect.tryPromise({
          try: async () => {
            // Ensure parent directory exists
            mkdirSync(join(CLONE_BASE_DIR, repo.owner), { recursive: true });

            // Remove any partial/stale clone directory before starting
            if (existsSync(cloneDir)) {
              await rm(cloneDir, { recursive: true, force: true });
            }

            await runGitCloneWithTimeout(
              ["clone", "--depth=1", "--no-single-branch", cloneUrl, cloneDir],
              CLONE_TIMEOUT_MS,
            );

            // Strip the auth token from the remote URL (security hygiene)
            await runGit(
              [
                "remote",
                "set-url",
                "origin",
                `https://${GITHUB_HOST}/${repo.fullName}.git`,
              ],
              cloneDir,
            );
          },
          catch: (err) =>
            new CloneError({
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            }),
        }).pipe(
          Effect.matchEffect({
            onSuccess: () =>
              Effect.gen(function* () {
                // Mark as ready in DB then broadcast success
                db.update(repositories)
                  .set({ cloneStatus: "ready" })
                  .where(eq(repositories.id, repo.id))
                  .run();

                yield* wsHub.broadcast({
                  type: "repos:clone-status",
                  data: { repoId: repo.id, status: "ready" },
                });
              }),
            onFailure: (err) =>
              Effect.gen(function* () {
                // Clean up any partial clone directory (best effort)
                if (existsSync(cloneDir)) {
                  yield* Effect.tryPromise({
                    try: () => rm(cloneDir, { recursive: true, force: true }),
                    catch: () => undefined,
                  }).pipe(Effect.orElse(() => Effect.void));
                }

                // Record the failure in DB then broadcast error
                const errorMessage = err.message;
                db.update(repositories)
                  .set({ cloneStatus: "error", cloneError: errorMessage })
                  .where(eq(repositories.id, repo.id))
                  .run();

                yield* wsHub.broadcast({
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
      });

    return {
      cloneRepo,

      ensurePrWorktree: (
        repoId: string,
        prNumber: number,
        githubToken: string,
      ) =>
        Effect.tryPromise({
          try: async () => {
            const row = db
              .select()
              .from(repositories)
              .where(eq(repositories.id, repoId))
              .get();

            if (!row || row.cloneStatus !== "ready") {
              throw new CloneNotReadyError({ repoId });
            }

            const clonePath = row.clonePath;
            if (!clonePath) {
              throw new CloneNotReadyError({ repoId });
            }

            const worktreePath = join(clonePath, "worktrees", `pr-${prNumber}`);

            // Temporarily set authenticated remote URL for fetch
            const authedUrl = `https://x-access-token:${githubToken}@${GITHUB_HOST}/${row.fullName}.git`;
            const cleanUrl = `https://${GITHUB_HOST}/${row.fullName}.git`;

            try {
              await runGit(
                ["remote", "set-url", "origin", authedUrl],
                clonePath,
              );

              if (existsSync(worktreePath)) {
                // Worktree exists — fetch latest and reset inside it
                await runGit(
                  ["fetch", "origin", `refs/pull/${prNumber}/head`],
                  worktreePath,
                );
                await runGit(["reset", "--hard", "FETCH_HEAD"], worktreePath);
              } else {
                // Fresh setup — fetch ref into local branch, then create worktree
                await runGit(
                  [
                    "fetch",
                    "origin",
                    `+refs/pull/${prNumber}/head:refs/heads/pr-${prNumber}`,
                  ],
                  clonePath,
                );
                await runGit(
                  [
                    "worktree",
                    "add",
                    join("worktrees", `pr-${prNumber}`),
                    `pr-${prNumber}`,
                  ],
                  clonePath,
                );
              }
            } finally {
              await runGit(
                ["remote", "set-url", "origin", cleanUrl],
                clonePath,
              );
            }

            return worktreePath;
          },
          catch: (err) => {
            if (err instanceof CloneNotReadyError) return err;
            return new CloneError({
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            });
          },
        }),

      getCloneStatus: (repoId: string) =>
        // DB queries are synchronous (better-sqlite3 driver) so this is infallible
        Effect.sync(() => {
          const row = db
            .select()
            .from(repositories)
            .where(eq(repositories.id, repoId))
            .get();

          return {
            status: (row?.cloneStatus ?? "pending") as CloneStatus,
            path: row?.clonePath ?? null,
            error: row?.cloneError ?? null,
          };
        }),

      deleteClone: (repoId: string) =>
        Effect.tryPromise({
          try: async () => {
            const row = db
              .select()
              .from(repositories)
              .where(eq(repositories.id, repoId))
              .get();

            if (row?.clonePath) {
              // Guard against path traversal — only delete within the designated clone dir
              assertSafeClonePath(row.clonePath);

              if (existsSync(row.clonePath)) {
                await rm(row.clonePath, { recursive: true, force: true });
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

      acquireWalkthroughWorktree: (
        repoId: string,
        walkthroughId: string,
        prHeadSha: string,
        githubToken: string,
        prNumber: number,
      ) =>
        Effect.gen(function* () {
          const row = db
            .select()
            .from(repositories)
            .where(eq(repositories.id, repoId))
            .get();

          if (!row || row.cloneStatus !== "ready" || !row.clonePath) {
            return yield* Effect.fail(new CloneNotReadyError({ repoId }));
          }

          const clonePath = row.clonePath;
          const worktreePath = join(
            clonePath,
            "worktrees",
            `walkthrough-${walkthroughId}`,
          );

          // Build the worktree synchronously before registering the finalizer.
          // If this fails there's nothing to clean up — the finalizer would
          // otherwise try to remove a directory that was never created.
          yield* Effect.tryPromise({
            try: async () => {
              // Fetch the exact commit we want to pin to. `git worktree add`
              // needs a local ref/sha present in the clone. Most PR heads are
              // already reachable via the existing `pr-<n>` branch created by
              // ensurePrWorktree; fall back to fetching the PR ref if not.
              const authedUrl = `https://x-access-token:${githubToken}@${GITHUB_HOST}/${row.fullName}.git`;
              const cleanUrl = `https://${GITHUB_HOST}/${row.fullName}.git`;

              try {
                await runGit(
                  ["remote", "set-url", "origin", authedUrl],
                  clonePath,
                );
                // Make sure the exact SHA is present locally. `cat-file -e`
                // fails if the object isn't in the repo; on failure we fetch
                // the PR ref which is the source of truth for the head sha.
                const hasObjectProc = Bun.spawn(
                  ["git", "cat-file", "-e", `${prHeadSha}^{commit}`],
                  { cwd: clonePath, stdout: "pipe", stderr: "pipe" },
                );
                await hasObjectProc.exited;
                if (hasObjectProc.exitCode !== 0) {
                  await runGit(
                    [
                      "fetch",
                      "origin",
                      `+refs/pull/${prNumber}/head:refs/heads/pr-${prNumber}`,
                    ],
                    clonePath,
                  );
                }
              } finally {
                await runGit(
                  ["remote", "set-url", "origin", cleanUrl],
                  clonePath,
                );
              }

              // Clean up any stale directory from a previous crashed job with the
              // same walkthroughId. `git worktree add` refuses to overwrite, so
              // remove the registration first (ignoring errors), then rm the dir.
              const pruneProc = Bun.spawn(
                ["git", "worktree", "remove", "--force", worktreePath],
                { cwd: clonePath, stdout: "pipe", stderr: "pipe" },
              );
              await pruneProc.exited;
              if (existsSync(worktreePath)) {
                await rm(worktreePath, { recursive: true, force: true });
              }

              // Create the detached worktree pinned to the exact head sha —
              // "detached" means no local branch, so concurrent jobs for the
              // same PR never fight over `refs/heads/pr-N`.
              await runGit(
                ["worktree", "add", "--detach", worktreePath, prHeadSha],
                clonePath,
              );
            },
            catch: (err) =>
              new CloneError({
                message: err instanceof Error ? err.message : String(err),
                cause: err,
              }),
          });

          // Register cleanup on scope close. Best-effort: log and swallow so a
          // finalizer failure can never mask a downstream error or block fiber
          // exit. `git worktree remove --force` also deletes the directory, so
          // the rm() below is defensive for the case where the command fails.
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              try {
                const proc = Bun.spawn(
                  ["git", "worktree", "remove", "--force", worktreePath],
                  { cwd: clonePath, stdout: "pipe", stderr: "pipe" },
                );
                await proc.exited;
              } catch (err) {
                debug(
                  "walkthrough-worktree",
                  "worktree remove failed (will fall back to rm):",
                  err instanceof Error ? err.message : String(err),
                );
              }
              try {
                if (existsSync(worktreePath)) {
                  await rm(worktreePath, { recursive: true, force: true });
                }
              } catch (err) {
                logError(
                  "walkthrough-worktree",
                  "failed to rm worktree dir:",
                  err instanceof Error ? err.message : String(err),
                );
              }
            }),
          );

          return worktreePath;
        }),

      resumePendingClones: () =>
        Effect.gen(function* () {
          const pendingRepos = db
            .select()
            .from(repositories)
            .where(
              or(
                eq(repositories.cloneStatus, "pending"),
                eq(repositories.cloneStatus, "error"),
              ),
            )
            .all();

          if (pendingRepos.length === 0) return;

          debug(
            "repo-clone",
            `resuming ${pendingRepos.length} pending/error clone(s)`,
          );

          for (const repo of pendingRepos) {
            const tokenOption = yield* tokenProvider
              .getGitHubToken("single-user")
              .pipe(Effect.option);

            if (tokenOption._tag === "None") {
              debug(
                "repo-clone",
                `skipping repo ${repo.fullName} — no token available`,
              );
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
            };

            const token = tokenOption.value;
            yield* Effect.forkDaemon(
              cloneRepo(repoRecord, token).pipe(
                Effect.catchAll((err) => {
                  debug(
                    "repo-clone",
                    `clone failed for ${repo.fullName}: ${err.message}`,
                  );
                  return Effect.void;
                }),
              ),
            );
          }
        }),
    };
  }),
);
