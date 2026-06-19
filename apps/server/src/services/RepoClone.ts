import { Buffer } from "node:buffer";
import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloneStatus, Repository } from "@revv/shared";
import { and, eq, or } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { serverEnv } from "../config";
import { CLONE_TIMEOUT_MS } from "../constants";
import { repositories } from "../db/schema/index";
import {
  CloneError,
  CloneNotReadyError,
  type WorktreeBlockedByUnpushedCommits,
} from "../domain/errors";
import { debug, logError } from "../logger";
import { Broadcaster } from "./Broadcaster";
import {
  assertSafeManagedClonePath,
  CLONE_BASE_DIR,
  decideCloneDestination,
  existingPathIsUnder,
  expandUserPath,
  findWorktreesOnBranch,
  isGitRepo,
  parseRemoteFullName,
  pathIsUnder,
  readCloneDestinationState,
  remoteMatches,
  worktreeHolderPath,
} from "./clone-policy";
import { DbService } from "./Db";
import {
  ensureSignalHandlersInstalled,
  killStaleCloneProcesses,
  runGit,
  runGitBestEffort,
  runGitCapture,
  runGitCloneWithTimeout,
} from "./git-runner";
import { TokenProvider } from "./TokenProvider";

/**
 * Hard upper bound on file sizes the frontend will render. Anything bigger
 * gets a "too large to preview" placeholder rather than a 50 MB JSON payload
 * across the loopback. Tuned by feel — most source files in real PRs sit
 * well under this; bundles and lockfiles can blow past it.
 */
const MAX_FILE_CONTENT_BYTES = 5 * 1024 * 1024;

/**
 * Bytes scanned at the head of the file when sniffing for binary content.
 * A single NUL in this window flips the file to binary, which mirrors the
 * heuristic used by `git diff` and most shell tools.
 */
const BINARY_SNIFF_SAMPLE_BYTES = 8 * 1024;

// Tail of the in-flight `acquirePrWorktree` queue, keyed by
// `${repoId}:${prNumber}`. Two concurrent acquires for the same PR — e.g. a
// composer warm-up and the first real chat turn firing within the
// git-fetch/`worktree add` window — would otherwise both run `git worktree add`
// on the same path (TOCTOU → "already exists" / lock contention). Callers
// *chain* onto the current tail so they run sequentially. Chaining (rather than
// sharing one resolved promise) is deliberate: each caller re-runs the body and
// resolves to *its own* `prHeadSha`. A follower hits the existing-worktree fast
// path and, on a head-moved race where the winner left a different SHA checked
// out, resets the worktree to the SHA *it* asked for — sharing one promise would
// silently hand the follower the winner's SHA.
const inflightWorktreeAcquires = new Map<
  string,
  Promise<{ worktreePath: string; branchName: string }>
>();

// ── Service definition ────────────────────────────────────────────────────────

export class RepoCloneService extends Context.Tag("RepoCloneService")<
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
     * Acquire (or refresh) the single shared git worktree for a PR.
     *
     * One worktree per PR — used by both walkthrough generation (read-only)
     * and the AI chat (read/write). Path is
     * `~/.revv/repos/{owner}/{name}/worktrees/pr-{prNumber}`, always checked out on the local
     * tracking branch `revv/pr-{prNumber}`. The worktree is long-lived: it is NOT
     * torn down on scope close, on chat clear, or on SHA change. It only
     * goes away when the PR row is deleted or the repo is removed.
     *
     * Lifecycle:
     *   - **First acquire (no dir on disk):** fetch the resolved head SHA
     *     from GitHub, update `refs/revv-pull/N`, then `git worktree add -B
     *     revv/pr-N` checks it out at the new branch.
     *     The fetch ref lives under `refs/revv-pull/` (not `refs/revv/pr-N`)
     *     so it can't shadow the bare branch name `revv/pr-N` — see the
     *     `prFetchRef` comment in the body.
     *   - **Already exists, branch == pr-N, HEAD == prHeadSha:** no-op.
     *   - **Already exists, branch == pr-N, different HEAD:** fetch the PR
     *     ref into FETCH_HEAD *inside the worktree* (so the in-place
     *     `pr-N` checkout doesn't trip "refusing to fetch into branch …
     *     checked out at <path>"), then `git reset --hard FETCH_HEAD`
     *     advances both the worktree and the branch ref.
     *   - **Already exists but on the wrong branch / corrupted:** prune,
     *     remove, recreate.
     *
     * Concurrency note: the walkthrough agent is read-only and the chat
     * agent can `Write`/`Edit`/`Bash`. Per the agreed design, callers
     * accept the race — both can use the same dir at the same time. A
     * `git reset --hard` triggered by an in-place SHA refresh while the
     * other agent is mid-read is the only real hazard, and it's rare in
     * practice (the chat is interactive, the walkthrough is bursty).
     */
    readonly acquirePrWorktree: (params: {
      readonly repoId: string;
      readonly prNumber: number;
      readonly prHeadSha: string;
      readonly githubToken: string;
      readonly exactHead?: boolean;
    }) => Effect.Effect<
      { readonly worktreePath: string; readonly branchName: string },
      CloneError | CloneNotReadyError | WorktreeBlockedByUnpushedCommits
    >;
  }
>() {}

// ── Helpers ───────────────────────────────────────────────────────────────────
//
// Subprocess plumbing (spawnGit / runGit / runGitCapture / activeProcs registry /
// signal handlers / killStaleCloneProcesses) lives in ./git-runner so the
// merge-and-push service shares the same process registry. Importing
// `runGit*` here keeps existing call sites unchanged.

/**
 * Read the contents of a worktree's `.git` HEAD file. For a worktree-checkout
 * `.git` is a single-line file pointing at the actual gitdir; the actual HEAD
 * lives at `<gitdir>/HEAD`. We resolve that, then return the trimmed line.
 *
 * Returns null on any read failure. Used by `acquirePrWorktree` to skip the
 * recreate path when the directory is already on the expected branch.
 */
async function readGitHead(worktreePath: string): Promise<string | null> {
  try {
    const dotGitPath = join(worktreePath, ".git");
    const dotGit = await Bun.file(dotGitPath).text();
    const trimmed = dotGit.trim();
    // For worktree checkouts, .git is a file: `gitdir: <abs path>`.
    // For regular checkouts, it's a directory containing HEAD directly.
    let gitdir: string;
    if (trimmed.startsWith("gitdir:")) {
      gitdir = trimmed.slice("gitdir:".length).trim();
    } else {
      gitdir = dotGitPath;
    }
    const headPath = join(gitdir, "HEAD");
    const head = await Bun.file(headPath).text();
    return head.trim().replace(/^ref:\s*/, "");
  } catch {
    return null;
  }
}

/**
 * Best-effort removal of stale git lock files belonging to this PR's worktree
 * and branch ref. When the Claude Code subprocess is SIGTERM'd mid-tool-call
 * (walkthrough cancel / supersede), git operations it had in flight can leave
 * `.lock` files behind that no current process is holding. The next
 * `git fetch` / `git reset` then aborts with `Unable to create '...': File exists`
 * (or, worse, sits in a retry loop), and the wedge persists across server
 * restarts because nothing on disk gets cleaned up — until the user removes
 * and re-adds the repo.
 *
 * Scope is intentionally narrow: only locks tied to *this* PR's worktree
 * gitdir and its branch ref. Bare-clone-wide locks (index.lock, packed-refs.lock,
 * shallow.lock, etc.) are deliberately NOT touched because a sibling
 * walkthrough job for a different PR could be holding them legitimately —
 * `MAX_CONCURRENT_JOBS = 5` allows that concurrency.
 */
async function clearStalePrWorktreeLocks(
  clonePath: string,
  prDirName: string,
  branchName: string,
): Promise<void> {
  const worktreeGitdir = join(clonePath, ".git", "worktrees", prDirName);
  const candidates = [
    join(worktreeGitdir, "index.lock"),
    join(worktreeGitdir, "HEAD.lock"),
    join(clonePath, ".git", "refs", "heads", `${branchName}.lock`),
  ];
  for (const lockPath of candidates) {
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
 * Check whether a commit SHA is present in the local object store. Used as a
 * cheap gate before attempting `reset --hard` so we can fetch the SHA on
 * demand rather than letting reset fail with the cryptic
 * `fatal: Could not parse object 'SHA'`.
 */
async function commitExists(cwd: string, sha: string): Promise<boolean> {
  try {
    await runGit(["cat-file", "-e", `${sha}^{commit}`], cwd, 10_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure `prHeadSha` is present in the local object store at `cwd`, fetching
 * from `origin` if necessary.
 *
 * Why this exists: the previous flow fetched `refs/pull/{N}/head` (the PR's
 * *current* head on GitHub) and then `reset --hard prHeadSha`. When the PR
 * advanced or was force-pushed between the metadata resolution that produced
 * `prHeadSha` and the worktree acquire, the fetched ref no longer contained
 * the requested SHA and reset failed with `fatal: Could not parse object`.
 *
 * Strategy:
 *   1. Fast path — SHA already in objects, no remote round-trip.
 *   2. Targeted SHA fetch (`git fetch origin <sha>`). GitHub honors this for
 *      any commit reachable from any ref via `uploadpack.allowReachableSHA1InWant`,
 *      which is enabled by default and crucially covers commits that were
 *      force-pushed away from a PR — they remain reachable through GitHub's
 *      internal refs for ~90 days.
 *   3. Fallback — fetch the PR's current head ref. Only useful when (a) the
 *      direct-SHA fetch is blocked (e.g. a self-hosted GHE with the want-SHA
 *      knob disabled) AND (b) `prHeadSha` happens to match the current head.
 *
 * Throws with a clear, user-actionable message if the SHA can't be obtained.
 */
async function ensurePrCommitPresent(
  cwd: string,
  prHeadSha: string,
  prNumber: number,
  authedUrl: string,
): Promise<void> {
  if (await commitExists(cwd, prHeadSha)) return;

  let directFetchError: unknown = null;
  try {
    await runGit(["fetch", "--no-tags", authedUrl, prHeadSha], cwd);
    if (await commitExists(cwd, prHeadSha)) return;
  } catch (err) {
    directFetchError = err;
    debug(
      "pr-worktree",
      `direct SHA fetch failed for ${prHeadSha}, falling back to PR ref:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    await runGit(["fetch", "--no-tags", authedUrl, `refs/pull/${prNumber}/head`], cwd);
  } catch (err) {
    throw new Error(
      [
        `Unable to fetch PR #${prNumber} head commit ${prHeadSha}.`,
        "GitHub did not provide the direct commit or refs/pull head ref.",
        "The PR may have been force-pushed, deleted, moved, or the local PR metadata may be stale.",
        `Direct SHA fetch: ${directFetchError instanceof Error ? directFetchError.message : String(directFetchError)}`,
        `PR ref fetch: ${err instanceof Error ? err.message : String(err)}`,
      ].join(" "),
    );
  }

  if (!(await commitExists(cwd, prHeadSha))) {
    throw new Error(
      `commit ${prHeadSha} is not available on origin — it may have been force-pushed away or garbage-collected by GitHub`,
    );
  }
}

// ── Live implementation ───────────────────────────────────────────────────────

export const RepoCloneServiceLive = Layer.effect(
  RepoCloneService,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const broadcaster = yield* Broadcaster;
    const tokenProvider = yield* TokenProvider;

    // Install the signal handlers eagerly so even an early crash (before
    // the first clone is attempted) gets clean child-process teardown.
    ensureSignalHandlersInstalled();

    // Reap any orphan git processes left over from a previous lifetime.
    // They reference paths we're about to wipe and lockfiles we're about
    // to recreate; without this, `resumePendingClones` below would just
    // add a new combatant to the brawl.
    yield* Effect.promise(() => killStaleCloneProcesses());

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
            const cleanUrl = `https://${gitHost}/${repo.fullName}.git`;
            const authHeader = `Authorization: Basic ${Buffer.from(
              `x-access-token:${githubToken}`,
            ).toString("base64")}`;

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

                await runGitCloneWithTimeout(
                  [
                    "-c",
                    `http.extraHeader=${authHeader}`,
                    "clone",
                    "--depth=1",
                    cleanUrl,
                    cloneDir,
                  ],
                  CLONE_TIMEOUT_MS,
                );

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

                    yield* broadcaster.broadcastToAccount(accountId, {
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
                      }).pipe(Effect.orElse(() => Effect.void));
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

                    yield* broadcaster.broadcastToAccount(accountId, {
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
            await broadcaster.broadcastToAccount(accountId, {
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
          await broadcaster.broadcastToAccount(accountId, {
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

    return {
      cloneRepo,
      linkExisting,

      inspectLocal: (localPath, gitHost) =>
        Effect.tryPromise({
          try: async () => {
            const repoReady = existsSync(localPath) && (await isGitRepo(localPath));
            if (!repoReady) {
              return { isGitRepo: false, proposedFullName: null, remotes: [] };
            }

            let out = "";
            try {
              out = await runGitCapture(["remote", "-v"], localPath, 10_000);
            } catch {
              out = "";
            }

            const seen = new Set<string>();
            const remotes: { name: string; url: string }[] = [];
            for (const line of out.split("\n")) {
              const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
              if (!match) continue;
              const [, name, url] = match;
              if (!name || !url) continue;
              const key = `${name}\0${url}`;
              if (seen.has(key)) continue;
              seen.add(key);
              remotes.push({ name, url });
            }

            const origin = remotes.find((remote) => remote.name === "origin");
            const proposedFullName =
              (origin ? parseRemoteFullName(origin.url, gitHost) : null) ??
              remotes.map((remote) => parseRemoteFullName(remote.url, gitHost)).find(Boolean) ??
              null;

            return { isGitRepo: true, proposedFullName, remotes };
          },
          catch: (err) =>
            new CloneError({
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            }),
        }),

      acquirePrWorktree: ({ repoId, prNumber, prHeadSha, githubToken, exactHead = false }) =>
        Effect.withSpan("RepoClone.acquirePrWorktree", {
          attributes: { repoId, prNumber, headSha: prHeadSha },
        })(
          Effect.gen(function* () {
            return yield* Effect.tryPromise({
              try: async () => {
                const acquireKey = `${repoId}:${prNumber}`;
                const runAcquire = async () => {
                  const row = db
                    .select()
                    .from(repositories)
                    .where(eq(repositories.id, repoId))
                    .get();

                  if (!row || row.cloneStatus !== "ready" || !row.clonePath) {
                    throw new CloneNotReadyError({ repoId });
                  }

                  const gitHost = row.githubHost ?? serverEnv.githubHost;
                  const clonePath = row.clonePath;
                  const prDirName = `pr-${prNumber}`;
                  const branchName = `revv/pr-${prNumber}`;
                  // The PR head is fetched into a dedicated namespace that can
                  // NEVER collide with the local working branch. Git resolves a
                  // bare ref name by trying `refs/<name>` before
                  // `refs/heads/<name>` (see gitrevisions(7)), so the earlier
                  // scheme that fetched into `refs/revv/pr-N` made the bare name
                  // `revv/pr-N` ambiguous with the branch `refs/heads/revv/pr-N`
                  // — and resolved to the *immutable PR head* instead of the
                  // working branch. That silently broke every bare-branch git op
                  // (rev-list miscounted to 0 → "No agent commits to push",
                  // `git merge revv/pr-N` reported "Already up to date" and
                  // merged nothing, etc.). `refs/revv-pull/N` shares no name
                  // with any branch, so the bare branch name is unambiguous.
                  const prFetchRef = `refs/revv-pull/${prNumber}`;
                  const holderBase = worktreeHolderPath(row.owner, row.name);
                  const worktreePath = join(holderBase, prDirName);

                  const authedUrl = `https://x-access-token:${githubToken}@${gitHost}/${row.fullName}.git`;

                  mkdirSync(holderBase, { recursive: true });

                  // Clear any per-worktree git locks left behind by a
                  // SIGTERM'd previous run before any git operation that
                  // would block on them.
                  await clearStalePrWorktreeLocks(clonePath, prDirName, branchName);

                  // Heal clones seeded by the old scheme: delete the stale
                  // `refs/revv/pr-N` ref so it stops shadowing the working
                  // branch `refs/heads/revv/pr-N`. Best-effort and idempotent —
                  // a no-op on clones that never had it. Runs on every acquire
                  // (including the existing-worktree early-return paths below) so
                  // an already-checked-out worktree is fixed in place without a
                  // teardown, preserving any unpushed agent commits.
                  await runGitBestEffort(
                    ["update-ref", "-d", `refs/revv/pr-${prNumber}`],
                    clonePath,
                    10_000,
                  );

                  // Self-heal a worktree wedged in a mid-merge or
                  // mid-rebase state — leftovers of a SIGKILL'd
                  // merge-and-push run.
                  if (existsSync(worktreePath)) {
                    await runGitBestEffort(["merge", "--abort"], worktreePath, 10_000);
                    await runGitBestEffort(["rebase", "--abort"], worktreePath, 10_000);
                  }

                  if (existsSync(worktreePath)) {
                    // Existing dir — verify it's actually on the expected
                    // branch. A wrong-branch / detached / corrupted state
                    // means we tear down and recreate; otherwise we move
                    // the worktree to `prHeadSha` in place.
                    const headRef = await readGitHead(worktreePath);
                    if (headRef === `refs/heads/${branchName}`) {
                      const currentSha = (
                        await runGitCapture(["rev-parse", "HEAD"], worktreePath)
                      ).trim();
                      if (currentSha === prHeadSha) {
                        return { worktreePath, branchName };
                      }
                      const isAncestor = await runGitBestEffort(
                        ["merge-base", "--is-ancestor", prHeadSha, currentSha],
                        worktreePath,
                      );
                      if (isAncestor && !exactHead) {
                        return { worktreePath, branchName };
                      }
                      await ensurePrCommitPresent(worktreePath, prHeadSha, prNumber, authedUrl);
                      await runGit(["reset", "--hard", prHeadSha], worktreePath);
                      return { worktreePath, branchName };
                    }
                    // Wrong branch / detached / corrupted — tear down so
                    // the fresh-setup path below can recreate cleanly.
                    await runGitBestEffort(
                      ["worktree", "remove", "--force", worktreePath],
                      clonePath,
                      10_000,
                    );
                    await rm(worktreePath, {
                      recursive: true,
                      force: true,
                    });
                  }

                  // Fresh worktree path. Prune stale `.git/worktrees/<name>`
                  // entries first — without this `git worktree add` would
                  // fail with "already exists" on a half-cleaned previous
                  // run. Idempotent on success.
                  await runGitBestEffort(["worktree", "prune"], clonePath, 15_000);

                  // Reclaim Revv-owned squatters only. User-created worktrees
                  // on the same branch are outside our holder and must survive.
                  const squatters = await findWorktreesOnBranch(clonePath, branchName);
                  for (const squatter of squatters) {
                    if (squatter === worktreePath) continue;
                    if (!existingPathIsUnder(squatter, CLONE_BASE_DIR)) {
                      debug("pr-worktree", `leaving non-Revv squatter alone: ${squatter}`);
                      continue;
                    }
                    await runGitBestEffort(
                      ["worktree", "remove", "--force", squatter],
                      clonePath,
                      10_000,
                    );
                    try {
                      if (existsSync(squatter)) {
                        await rm(squatter, {
                          recursive: true,
                          force: true,
                        });
                      }
                    } catch (err) {
                      logError(
                        "pr-worktree",
                        "failed to rm squatter dir:",
                        err instanceof Error ? err.message : String(err),
                      );
                    }
                  }
                  if (squatters.length > 0) {
                    await runGitBestEffort(["worktree", "prune"], clonePath, 15_000);
                  }

                  await ensurePrCommitPresent(clonePath, prHeadSha, prNumber, authedUrl);
                  await runGit(["update-ref", prFetchRef, prHeadSha], clonePath);
                  await runGit(
                    ["worktree", "add", "-B", branchName, worktreePath, prHeadSha],
                    clonePath,
                  );
                  const tipSha = (await runGitCapture(["rev-parse", "HEAD"], worktreePath)).trim();
                  if (tipSha !== prHeadSha) {
                    await ensurePrCommitPresent(worktreePath, prHeadSha, prNumber, authedUrl);
                    await runGit(["reset", "--hard", prHeadSha], worktreePath);
                  }
                  return { worktreePath, branchName };
                };

                // Chain onto the current tail so concurrent acquires for the
                // same worktree path run sequentially (no racing `git worktree
                // add`). A rejected predecessor must not poison followers, so we
                // swallow its outcome before running our own body.
                const prev = inflightWorktreeAcquires.get(acquireKey);
                const acquire = (prev ? prev.catch(() => {}) : Promise.resolve()).then(runAcquire);
                inflightWorktreeAcquires.set(acquireKey, acquire);
                try {
                  return await acquire;
                } finally {
                  // Only clear if we're still the tail — a later caller may have
                  // already chained onto us and taken over the slot.
                  if (inflightWorktreeAcquires.get(acquireKey) === acquire) {
                    inflightWorktreeAcquires.delete(acquireKey);
                  }
                }
              },
              catch: (err) => {
                if (err instanceof CloneNotReadyError) return err;
                return new CloneError({
                  message: err instanceof Error ? err.message : String(err),
                  cause: err,
                });
              },
            });
          }),
        ),

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

            // `<sha>:<path>` is git's tree-spec syntax. The path is
            // relative to repo root with forward slashes regardless
            // of platform. Sizes come back as plain integers on
            // stdout; missing objects exit non-zero and runGit*
            // would throw — we map that to a clean not-found.
            const objectSpec = `${headSha}:${path}`;

            let sizeOut: string;
            try {
              sizeOut = await runGitCapture(["cat-file", "-s", objectSpec], clonePath, 30_000);
            } catch {
              // Most common cause: the path doesn't exist at
              // this SHA (renames + deletions). cat-file also
              // errors on type mismatch (e.g. asking a tree
              // for its size), which is fine to treat the same
              // way — the user clicked something that's not a
              // blob and we surface "not found".
              return { status: "not-found" } as const;
            }

            const size = Number.parseInt(sizeOut.trim(), 10);
            if (!Number.isFinite(size)) {
              return { status: "not-found" } as const;
            }

            if (size > MAX_FILE_CONTENT_BYTES) {
              return { status: "too-large", size } as const;
            }

            const content = await runGitCapture(["cat-file", "-p", objectSpec], clonePath, 60_000);

            // Binary sniffing — same heuristic as `git diff`: any
            // NUL byte in the first 8 KB flips the verdict. The
            // content string was decoded via TextDecoder
            // (replacement char on invalid UTF-8) so a true binary
            // will both contain `\0` from real NULs *and* lots
            // of U+FFFD; the NUL test alone is sufficient and
            // avoids false positives on valid Unicode replacement
            // characters that happen to be in legitimate text.
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
              if (row.clonePath && existsSync(row.clonePath)) {
                await runGitBestEffort(["worktree", "prune"], row.clonePath, 15_000);
              }

              const holder = worktreeHolderPath(row.owner, row.name);
              if (existsSync(holder)) {
                await rm(holder, { recursive: true, force: true });
              }

              if (row.clonePath && row.managed) {
                assertSafeManagedClonePath(row.clonePath);
                await rm(row.clonePath, { recursive: true, force: true });
              } else if (row.clonePath) {
                // The holder dir (and its `pr-*` worktrees) was just
                // removed above, but git still tracks those worktrees in
                // `.git/worktrees`. Prune again now that the directories
                // are gone — otherwise the `branch -D` calls below abort
                // with "branch is used by worktree" against the stale
                // metadata.
                if (existsSync(row.clonePath)) {
                  await runGitBestEffort(["worktree", "prune"], row.clonePath, 15_000);
                }

                const branches = await runGitCapture(
                  ["branch", "--list", "revv/pr-*", "--format=%(refname:short)"],
                  row.clonePath,
                  15_000,
                ).catch(() => "");
                for (const branch of branches
                  .split("\n")
                  .map((b) => b.trim())
                  .filter(Boolean)) {
                  await runGitBestEffort(["branch", "-D", branch], row.clonePath, 15_000);
                }

                // Both namespaces: `refs/revv-pull/*` is the current PR-head
                // fetch target; `refs/revv/*` is the legacy target left on
                // clones seeded by the old scheme. `refs/revv` does NOT prefix
                // `refs/revv-pull` (the char after `refs/revv` is `-`, not
                // `/`), so both patterns are required.
                const refs = await runGitCapture(
                  ["for-each-ref", "--format=%(refname)", "refs/revv", "refs/revv-pull"],
                  row.clonePath,
                  15_000,
                ).catch(() => "");
                for (const ref of refs
                  .split("\n")
                  .map((r) => r.trim())
                  .filter(Boolean)) {
                  await runGitBestEffort(["update-ref", "-d", ref], row.clonePath, 15_000);
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
            const tokenOption = yield* tokenProvider
              .getTokenByAccountId(repo.accountId)
              .pipe(Effect.option);

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
            yield* Effect.forkDaemon(
              cloneRepo(repoRecord, token, repo.accountId).pipe(
                Effect.catchAll((err) => {
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
