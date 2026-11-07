// The one owner of a repository row's clone: its folder (see `layout.ts`), its
// status in SQLite and the `repos:clone-status` broadcast that follows every
// status write, and the review worktrees walkthrough jobs check out of it.
// Agent worktrees belong to `workspace/agent-worktrees.ts`.
//
// A managed clone is Revv's: cloned (or adopted) by it, deleted with the repo.
// A linked one is the user's checkout: never cloned over, never deleted; only
// Revv's own branches and refs are removed from it. A folder belongs to one row.

import { existsSync, mkdirSync, readdirSync, realpathSync, rmdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { CloneStatus, Repository } from "@revv/shared";
import { spanName } from "@revv/shared/telemetry";
import { and, asc, eq, isNotNull, or } from "drizzle-orm";
import { Context, Effect, Layer, type Scope } from "effect";
import { repositories, walkthroughs } from "../../db/schema/index";
import { CloneError, CloneNotReadyError, type DbError } from "../../domain/errors";
import { dbTry } from "../../effects/db-try";
import { debug, logError } from "../../logger";
import { DbService } from "../Db";
import {
  blobContent,
  blobSize,
  commitExists,
  deleteBranch,
  deleteRef,
  fetch,
  isGitRepo,
  listRefs,
  listWorktrees,
  moveWorktree,
  reapOrphanedGitProcesses,
  remotes,
  removeWorktree,
  shallowClone,
} from "../git/ops";
import { agentBranchPr, REVV_REF_NAMESPACES } from "../git/pr-refs";
import { authedRemoteUrl, cloneSource } from "../git/remote";
import { clearScratch, prepareScratch } from "../git/scratch";
import { GitHubAccounts } from "../github/accounts";
import { Realtime } from "../Realtime";
import {
  agentWorktreePr,
  CLONE_BASE_DIR,
  type CloneLayout,
  cloneLayout,
  reviewWorktreeId,
} from "./layout";
import {
  decideCloneDestination,
  existingPathIsUnder,
  expandUserPath,
  managedCloneRemovalRefusal,
  parseRemoteFullName,
  pathIsUnder,
  readCloneDestinationState,
  remoteMatches,
} from "./policy";

const CLONE_TIMEOUT_MS = 600_000;

/** Files larger than this get a "too large to preview" placeholder instead of their content. */
const MAX_FILE_CONTENT_BYTES = 5 * 1024 * 1024;

/** A NUL in this many leading bytes marks a file binary, as `git diff` decides it. */
const BINARY_SNIFF_SAMPLE_BYTES = 8 * 1024;

type RepoRow = typeof repositories.$inferSelect;

/** A ready clone. */
export interface ReadyClone {
  readonly repo: RepoRow;
  readonly clonePath: string;
}

/** Where one run works in a repository: its scratch worktree, and the authed remote. */
export interface ScratchPlace {
  readonly clonePath: string;
  readonly scratchPath: string;
  readonly remoteUrl: string;
}

export class RepoCloneService extends Context.Service<
  RepoCloneService,
  {
    readonly layout: CloneLayout;
    /**
     * Bring the repo's clone to `ready`: clone or adopt a managed one (into
     * `basePath` instead of Revv's base, for a first clone), revalidate a
     * linked one. The outcome is the row's clone status, broadcast.
     */
    readonly ensureClone: (
      repoId: string,
      opts?: { readonly basePath?: string },
    ) => Effect.Effect<void, CloneError | DbError>;
    /** Link the user's checkout at `localPath`, which must be a clone of the repo no other row uses. */
    readonly linkExisting: (
      repoId: string,
      localPath: string,
    ) => Effect.Effect<void, CloneError | DbError>;
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
     * A file at `headSha` from the local clone, for a file outside the PR's
     * diff. Binaries come back with empty `content` so the UI renders a
     * placeholder.
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
      CloneError | DbError
    >;
    readonly getCloneStatus: (repoId: string) => Effect.Effect<
      {
        status: CloneStatus;
        path: string | null;
        error: string | null;
      },
      DbError
    >;
    readonly readyClone: (
      repoId: string,
    ) => Effect.Effect<ReadyClone, CloneNotReadyError | DbError>;
    /** A run's scratch worktree in the repo's clone, or null while the clone isn't ready. */
    readonly scratchPlace: (
      repo: Repository,
      token: string,
      scratchPath: (layout: CloneLayout) => string,
    ) => ScratchPlace | null;
    /**
     * Remove every worktree Revv checked out of the clone, then the clone
     * itself when Revv manages it; a linked checkout loses only Revv's
     * branches and refs. What can't be removed safely stays, logged.
     */
    readonly deleteClone: (repoId: string) => Effect.Effect<void, DbError>;
    /**
     * At boot, before anything reads a clone: restart the clones the last
     * shutdown cut off, give each row its own folder (an older Revv let two
     * rows share one), move worktrees out of the older shared layout, then
     * resume managed clones left `pending` or `error`.
     */
    readonly recoverAtBoot: () => Effect.Effect<void, DbError>;
    /**
     * A detached worktree at `headSha` for one walkthrough generation,
     * removed when the scope closes (CLAUDE.md invariant 10). Its path is
     * keyed on the walkthrough, so a resumed run clears what a killed one
     * left, and `sweepReviewWorktrees` removes those of runs that never resume.
     */
    readonly acquireReviewWorktree: (params: {
      readonly repoId: string;
      readonly prNumber: number;
      readonly headSha: string;
      readonly githubToken: string;
      readonly walkthroughId: string;
    }) => Effect.Effect<string, CloneError | CloneNotReadyError | DbError, Scope.Scope>;
    /** Remove the review worktrees of walkthroughs no longer generating: their run died and won't resume. */
    readonly sweepReviewWorktrees: () => Effect.Effect<void, DbError>;
  }
>()("RepoCloneService") {}

/**
 * Make `prHeadSha` present in the object store, fetching it if needed.
 *
 * The SHA itself is fetched first: GitHub serves any commit reachable from
 * any of its refs (`uploadpack.allowReachableSHA1InWant`), which includes
 * commits force-pushed away from a PR for about 90 days. A GitHub Enterprise
 * that disables that gets the PR's current head ref instead, which only helps
 * when `prHeadSha` still is that head.
 */
export async function ensurePrCommitPresent(
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

export const toCloneError = (err: unknown) =>
  err instanceof CloneError
    ? err
    : new CloneError({ message: err instanceof Error ? err.message : String(err), cause: err });

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether two paths name one folder; git reports worktrees by their real path. */
export function samePath(a: string, b: string): boolean {
  return realPath(a) === realPath(b);
}

/** Remove `dir` if nothing is left in it. */
function removeIfEmpty(dir: string): void {
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    /* someone wrote into it meanwhile */
  }
}

/** The service over clones and worktrees under `base`: `REVV_CLONE_DIR`, or a temp dir in tests. */
export const repoCloneLayer = (base: string) =>
  Layer.effect(
    RepoCloneService,
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const realtime = yield* Realtime;
      const accounts = yield* GitHubAccounts;
      const layout = cloneLayout(base);

      yield* Effect.promise(() => reapOrphanedGitProcesses(base));

      // Keeps startup-resume, the add route and the retry route from running
      // concurrent clones of one repo. SQLite stays authoritative for status;
      // this set is a process-local short-circuit.
      const inFlightClones = new Set<string>();

      const readRow = (repoId: string) =>
        dbTry("repository read", () =>
          db.select().from(repositories).where(eq(repositories.id, repoId)).get(),
        );

      /** The row other than `repoId` whose clone lives at `path`, if any. */
      const otherHolderOf = (path: string, repoId: string) =>
        dbTry(
          "clone path owners read",
          () =>
            db
              .select({
                id: repositories.id,
                fullName: repositories.fullName,
                clonePath: repositories.clonePath,
              })
              .from(repositories)
              .where(isNotNull(repositories.clonePath))
              .all()
              .find(
                (row) =>
                  row.id !== repoId && row.clonePath !== null && samePath(row.clonePath, path),
              ) ?? null,
        );

      /** Write the row's clone fields, then tell its account. */
      const setCloneState = (
        row: RepoRow,
        patch: {
          readonly cloneStatus: CloneStatus;
          readonly cloneError: string | null;
          readonly clonePath?: string | null;
          readonly managed?: boolean;
        },
      ) =>
        Effect.gen(function* () {
          yield* dbTry("repository clone state write", () =>
            db.update(repositories).set(patch).where(eq(repositories.id, row.id)).run(),
          );
          yield* realtime.toAccount(row.accountId, {
            type: "repos:clone-status",
            data: {
              repoId: row.id,
              status: patch.cloneStatus,
              ...(patch.cloneError !== null ? { error: patch.cloneError } : {}),
            },
          });
        });

      const failClone = (row: RepoRow, message: string) =>
        Effect.gen(function* () {
          // Callers fork the clone and drop its error, so this is the only
          // server-side trace of the failure.
          logError("repo-clone", `clone failed for ${row.fullName}: ${message}`);
          yield* setCloneState(row, { cloneStatus: "error", cloneError: message });
          return yield* Effect.fail(new CloneError({ message }));
        });

      const destinationFor = (row: RepoRow, basePath: string | undefined) =>
        Effect.gen(function* () {
          if (row.clonePath && (yield* otherHolderOf(row.clonePath, row.id)) === null) {
            return row.clonePath;
          }
          const root = basePath ? resolve(expandUserPath(basePath)) : layout.base;
          const preferred = layout.clonePath(root, row);
          return (yield* otherHolderOf(preferred, row.id)) === null
            ? preferred
            : layout.distinctClonePath(root, row);
        });

      const cloneManaged = (row: RepoRow, basePath: string | undefined) =>
        Effect.gen(function* () {
          const dest = yield* destinationFor(row, basePath);
          const token = yield* accounts.clientFor(row.accountId).pipe(
            Effect.map((client) => client.token),
            Effect.catch(() =>
              failClone(row, "No GitHub credential for this repository's account — sign in again"),
            ),
          );
          debug("repo-clone", `starting clone for ${row.fullName} -> ${dest}`);

          const state = yield* Effect.tryPromise({
            try: () => readCloneDestinationState(dest, row.githubHost, row.fullName),
            catch: toCloneError,
          }).pipe(Effect.catch((err) => failClone(row, err.message)));
          const decision = decideCloneDestination(state, pathIsUnder(dest, layout.base));
          switch (decision.action) {
            case "fail":
              return yield* failClone(row, decision.message);
            case "link":
              return yield* setCloneState(row, {
                managed: false,
                cloneStatus: "ready",
                clonePath: dest,
                cloneError: null,
              });
            case "adopt":
              return yield* setCloneState(row, {
                managed: true,
                cloneStatus: "ready",
                clonePath: dest,
                cloneError: null,
              });
            case "clone":
              break;
          }

          yield* setCloneState(row, {
            managed: true,
            cloneStatus: "cloning",
            clonePath: dest,
            cloneError: null,
          });
          const cloned = yield* Effect.tryPromise(async () => {
            mkdirSync(dirname(dest), { recursive: true });
            if (decision.removeExisting && existsSync(dest)) {
              await rm(dest, { recursive: true, force: true });
            }
            const source = cloneSource({ host: row.githubHost, fullName: row.fullName, token });
            return shallowClone(source.url, dest, source.authConfig, CLONE_TIMEOUT_MS);
          }).pipe(
            Effect.catch((err) =>
              Effect.succeed({ ok: false, stderr: String(err.cause), timedOut: false }),
            ),
          );
          if (!cloned.ok) {
            // Remove what this attempt wrote, and only that: before it began
            // the destination was missing, empty, or Revv's own leftover.
            yield* Effect.tryPromise(async () => {
              if (state === "empty") {
                for (const entry of readdirSync(dest)) {
                  await rm(join(dest, entry), { recursive: true, force: true });
                }
              } else {
                await rm(dest, { recursive: true, force: true });
              }
            }).pipe(Effect.catch(() => Effect.void));
            return yield* failClone(
              row,
              cloned.timedOut
                ? `git clone timed out after ${CLONE_TIMEOUT_MS / 1000}s; tail: ${cloned.stderr.slice(-512)}`
                : `git clone failed: ${cloned.stderr}`,
            );
          }
          debug("repo-clone", `clone ready for ${row.fullName} at ${dest}`);
          yield* setCloneState(row, { managed: true, cloneStatus: "ready", cloneError: null });
        });

      const linkExisting = (repoId: string, localPath: string) =>
        Effect.gen(function* () {
          const row = yield* readRow(repoId);
          if (!row) return;
          const failLink = (message: string) =>
            Effect.gen(function* () {
              yield* setCloneState(row, {
                managed: false,
                cloneStatus: "error",
                clonePath: localPath,
                cloneError: message,
              });
              return yield* Effect.fail(new CloneError({ message }));
            });

          const other = yield* otherHolderOf(localPath, row.id);
          if (other) {
            return yield* failLink(
              `${localPath} is already linked to ${other.fullName} for another account — link a different checkout`,
            );
          }
          const ready = yield* Effect.promise(
            async () => existsSync(localPath) && (await isGitRepo(localPath)),
          );
          if (!ready) return yield* failLink("Linked clone not found — re-link");
          // The route validates `fullName` against GitHub but not that the
          // path is a clone of it, and the user can edit the name after
          // inspection. Without this, `owner/A` could be linked to a clone of
          // `owner/B` and get `revv/pr-*` branches written into it.
          if (
            !(yield* Effect.promise(() => remoteMatches(localPath, row.githubHost, row.fullName)))
          ) {
            return yield* failLink(
              `Local clone's origin remote does not match ${row.fullName} — choose the matching checkout`,
            );
          }
          yield* setCloneState(row, {
            managed: false,
            cloneStatus: "ready",
            clonePath: localPath,
            cloneError: null,
          });
        });

      const ensureClone = (repoId: string, opts?: { readonly basePath?: string }) =>
        Effect.gen(function* () {
          const row = yield* readRow(repoId);
          if (!row) return;
          // A linked checkout is revalidated, never cloned: a missing path
          // would read as an empty destination and turn the user's folder
          // into a managed clone that a later removal deletes.
          if (!row.managed) {
            if (row.clonePath) yield* linkExisting(row.id, row.clonePath);
            return;
          }
          // The in-flight fiber does the status write and broadcast for this caller too.
          if (inFlightClones.has(row.id)) {
            debug("repo-clone", `clone already in flight for ${row.fullName}; skipping duplicate`);
            return;
          }
          inFlightClones.add(row.id);
          yield* cloneManaged(row, opts?.basePath).pipe(
            Effect.withSpan(spanName("repoClone", "ensureClone"), {
              attributes: { repoFullName: row.fullName },
            }),
            Effect.ensuring(Effect.sync(() => inFlightClones.delete(row.id))),
          );
        });

      const readyClone = (repoId: string) =>
        Effect.flatMap(readRow(repoId), (row) =>
          row?.cloneStatus === "ready" && row.clonePath
            ? Effect.succeed({ repo: row, clonePath: row.clonePath })
            : Effect.fail(new CloneNotReadyError({ repoId })),
        );

      /** A clone's Revv worktrees: every one under the base, other than the clone itself. */
      const removeRevvWorktrees = async (clonePath: string) => {
        for (const worktree of await listWorktrees(clonePath)) {
          if (samePath(worktree.path, clonePath)) continue;
          if (existingPathIsUnder(worktree.path, layout.base)) {
            await removeWorktree(clonePath, worktree.path);
          }
        }
      };

      const deleteClone = (repoId: string) =>
        Effect.gen(function* () {
          const row = yield* readRow(repoId);
          if (!row) return;
          const clonePath = row.clonePath && existsSync(row.clonePath) ? row.clonePath : null;
          const sharedWith = clonePath ? yield* otherHolderOf(clonePath, row.id) : null;
          const refusal =
            row.managed && clonePath && !sharedWith
              ? yield* Effect.promise(() => managedCloneRemovalRefusal(clonePath, layout.base, row))
              : null;

          yield* Effect.tryPromise(async () => {
            if (clonePath && !sharedWith) await removeRevvWorktrees(clonePath);
            await rm(layout.holder(row.id), { recursive: true, force: true });
            if (!clonePath) return;
            if (sharedWith) {
              logError(
                "repo-clone",
                `keeping ${clonePath}: ${sharedWith.fullName} (another account) still uses it`,
              );
            } else if (row.managed && refusal === null) {
              await rm(clonePath, { recursive: true, force: true });
            } else {
              if (refusal) logError("repo-clone", refusal);
              for (const ref of await listRefs(clonePath, ["refs/heads/revv/"])) {
                if (agentBranchPr(ref) !== null) {
                  await deleteBranch(clonePath, ref.slice("refs/heads/".length));
                }
              }
              for (const ref of await listRefs(clonePath, REVV_REF_NAMESPACES)) {
                await deleteRef(clonePath, ref);
              }
            }
          }).pipe(
            Effect.catch((err) =>
              Effect.sync(() =>
                logError("repo-clone", `removing ${row.fullName}'s clone failed:`, err.cause),
              ),
            ),
          );

          yield* dbTry("repository clone reset", () =>
            db
              .update(repositories)
              .set({ cloneStatus: "pending", clonePath: null, cloneError: null })
              .where(eq(repositories.id, repoId))
              .run(),
          );
        });

      /**
       * An older Revv keyed every folder on `owner/name`, so two rows of one
       * repository could share a clone. The earliest-added row keeps it; the
       * others get a managed clone of their own.
       */
      const unshareClones = dbTry("shared clone split", () => {
        const rows = db
          .select()
          .from(repositories)
          .where(isNotNull(repositories.clonePath))
          .orderBy(asc(repositories.addedAt))
          .all();
        const holders = new Set<string>();
        const split: RepoRow[] = [];
        for (const row of rows) {
          if (!row.clonePath) continue;
          const key = realPath(row.clonePath);
          if (holders.has(key)) split.push(row);
          else holders.add(key);
        }
        for (const row of split) {
          db.update(repositories)
            .set({ managed: true, clonePath: null, cloneStatus: "pending", cloneError: null })
            .where(eq(repositories.id, row.id))
            .run();
        }
        return split;
      });

      /**
       * Move a row's worktrees out of the older shared layout. Agent worktrees
       * keep their branch and uncommitted edits; scratch and review worktrees
       * are throwaway, so they are cleared.
       */
      const moveLegacyWorktrees = async (row: RepoRow, clonePath: string) => {
        const legacy = layout.legacyHolder(row);
        for (const worktree of await listWorktrees(clonePath)) {
          if (!samePath(dirname(worktree.path), legacy)) continue;
          const pr = agentWorktreePr(basename(worktree.path));
          if (pr === null) {
            await clearScratch(clonePath, worktree.path);
            continue;
          }
          const target = layout.agentWorktree(row.id, pr);
          if (existsSync(target)) continue;
          mkdirSync(layout.holder(row.id), { recursive: true });
          const moved = await moveWorktree(clonePath, worktree.path, target);
          if (!moved.ok) {
            logError(
              "repo-clone",
              `couldn't move ${worktree.path} to ${target}; the next chat turn retries:`,
              moved.stderr,
            );
          }
        }
        removeIfEmpty(legacy);
        removeIfEmpty(dirname(legacy));
      };

      const resumePendingClones = Effect.gen(function* () {
        const pending = yield* dbTry("pending clones read", () =>
          db
            .select({ id: repositories.id })
            .from(repositories)
            .where(
              and(
                eq(repositories.managed, true),
                or(eq(repositories.cloneStatus, "pending"), eq(repositories.cloneStatus, "error")),
              ),
            )
            .all(),
        );
        if (pending.length > 0) {
          debug("repo-clone", `resuming ${pending.length} pending/error clone(s)`);
        }
        for (const { id } of pending) {
          yield* Effect.forkDetach(ensureClone(id).pipe(Effect.catch(() => Effect.void)));
        }
      });

      const readyRows = dbTry("ready clones read", () =>
        db.select().from(repositories).where(eq(repositories.cloneStatus, "ready")).all(),
      );

      const recoverAtBoot = () =>
        Effect.gen(function* () {
          yield* dbTry("interrupted clones reset", () =>
            db
              .update(repositories)
              .set({ cloneStatus: "pending", cloneError: "Server restarted during clone" })
              .where(eq(repositories.cloneStatus, "cloning"))
              .run(),
          );
          for (const row of yield* unshareClones) {
            logError(
              "repo-clone",
              `${row.fullName} (account ${row.accountId}) shared another account's clone; giving it its own`,
            );
          }
          for (const row of yield* readyRows) {
            const clonePath = row.clonePath;
            if (!clonePath || !existsSync(clonePath)) continue;
            yield* Effect.tryPromise(() => moveLegacyWorktrees(row, clonePath)).pipe(
              Effect.catch((err) =>
                Effect.sync(() =>
                  logError("repo-clone", `legacy worktrees of ${row.fullName}:`, err.cause),
                ),
              ),
            );
          }
          yield* resumePendingClones;
        });

      const sweepReviewWorktrees = () =>
        Effect.gen(function* () {
          const generating = new Set(
            (yield* dbTry("generating walkthroughs read", () =>
              db
                .select({ id: walkthroughs.id })
                .from(walkthroughs)
                .where(eq(walkthroughs.status, "generating"))
                .all(),
            )).map((w) => w.id),
          );
          for (const row of yield* readyRows) {
            const clonePath = row.clonePath;
            if (!clonePath) continue;
            const holder = layout.holder(row.id);
            yield* Effect.promise(async () => {
              for (const worktree of await listWorktrees(clonePath)) {
                if (!samePath(dirname(worktree.path), holder)) continue;
                const id = reviewWorktreeId(basename(worktree.path));
                if (id !== null && !generating.has(id))
                  await clearScratch(clonePath, worktree.path);
              }
            });
          }
        });

      return {
        layout,
        ensureClone,
        linkExisting,
        readyClone,
        deleteClone,
        recoverAtBoot,
        sweepReviewWorktrees,

        scratchPlace: (repo, token, scratchPath) =>
          repo.cloneStatus === "ready" && repo.clonePath
            ? {
                clonePath: repo.clonePath,
                scratchPath: scratchPath(layout),
                remoteUrl: authedRemoteUrl({
                  host: repo.githubHost,
                  fullName: repo.fullName,
                  token,
                }),
              }
            : null,

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

        acquireReviewWorktree: ({ repoId, prNumber, headSha, githubToken, walkthroughId }) =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              const { repo, clonePath } = yield* readyClone(repoId);
              const path = layout.scratch.review(repoId, walkthroughId);
              yield* Effect.tryPromise({
                try: async () => {
                  await ensurePrCommitPresent(
                    clonePath,
                    headSha,
                    prNumber,
                    authedRemoteUrl({
                      host: repo.githubHost,
                      fullName: repo.fullName,
                      token: githubToken,
                    }),
                  );
                  const prepared = await prepareScratch(clonePath, path, headSha);
                  if (prepared.kind === "failed") throw new Error(prepared.message);
                },
                catch: toCloneError,
              });
              return { clonePath, path };
            }),
            ({ clonePath, path }) =>
              Effect.promise(() =>
                clearScratch(clonePath, path).catch((err) =>
                  logError("review-worktree", `couldn't remove ${path}:`, err),
                ),
              ),
          ).pipe(Effect.map(({ path }) => path)),

        getFileContentAtSha: (repoId, headSha, path) =>
          Effect.gen(function* () {
            const row = yield* readRow(repoId);
            if (!row) return { status: "cloning" } as const;
            if (row.cloneStatus === "error") {
              return { status: "error", message: row.cloneError ?? "Clone failed" } as const;
            }
            const clonePath = row.clonePath;
            if (row.cloneStatus !== "ready" || !clonePath) return { status: "cloning" } as const;

            return yield* Effect.tryPromise({
              try: async () => {
                const size = await blobSize(clonePath, headSha, path);
                if (size === null) return { status: "not-found" } as const;
                if (size > MAX_FILE_CONTENT_BYTES) return { status: "too-large", size } as const;
                const content = await blobContent(clonePath, headSha, path);
                const sniffEnd = Math.min(content.length, BINARY_SNIFF_SAMPLE_BYTES);
                for (let i = 0; i < sniffEnd; i++) {
                  if (content.charCodeAt(i) === 0) {
                    return { status: "ready", content: "", isBinary: true, size } as const;
                  }
                }
                return { status: "ready", content, isBinary: false, size } as const;
              },
              catch: toCloneError,
            });
          }),

        getCloneStatus: (repoId) =>
          Effect.map(readRow(repoId), (row) => ({
            status: row?.cloneStatus ?? "pending",
            path: row?.clonePath ?? null,
            error: row?.cloneError ?? null,
          })),
      };
    }),
  );

export const RepoCloneServiceLive = repoCloneLayer(CLONE_BASE_DIR);
