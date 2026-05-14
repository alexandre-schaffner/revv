import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { CloneStatus, Repository } from "@revv/shared";
import { eq, or } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { serverEnv } from "../config";
import { CLONE_TIMEOUT_MS } from "../constants";
import { repositories } from "../db/schema/index";
import { CloneError, CloneNotReadyError, WorktreeBlockedByUnpushedCommits } from "../domain/errors";
import { debug, logError } from "../logger";
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
import { WebSocketHub } from "./WebSocketHub";

// ── Constants ─────────────────────────────────────────────────────────────────

const CLONE_BASE_DIR = serverEnv.cloneDir;

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

// ── Service definition ────────────────────────────────────────────────────────

export class RepoCloneService extends Context.Tag("RepoCloneService")<
	RepoCloneService,
	{
		/** Start a shallow clone for a repo. Updates DB status. Fire-and-forget via Effect.fork. */
		readonly cloneRepo: (
			repo: Repository,
			githubToken: string,
		) => Effect.Effect<void, CloneError>;
		/**
		 * List every file path in the repo at a given commit SHA.
		 *
		 * Drives the sidebar repo-tree view. The response shape mirrors the
		 * route's success/in-progress/error trio so the HTTP layer can map it
		 * to 200 / 202 / 409 without special-casing thrown errors. Concretely:
		 *
		 *   - `'ready'`   → `paths` populated; tree can render.
		 *   - `'cloning'` → repo isn't fully cloned yet; the UI shows a
		 *                   "Cloning…" placeholder until a `repos:clone-status`
		 *                   broadcast flips status to `ready`.
		 *   - `'error'`   → clone failed; UI surfaces the recorded error.
		 *
		 * Behavior on `ready`: ensure the PR head ref is fetched into the
		 * local object store (no destination ref so the in-place `pr-N`
		 * worktree checkout isn't trampled), then `git ls-tree -r
		 * --name-only <headSha>` against the bare clone. No new worktree
		 * is created.
		 */
		readonly listFilesAtSha: (
			repoId: string,
			prNumber: number,
			headSha: string,
			githubToken: string,
		) => Effect.Effect<
			| { readonly status: "ready"; readonly paths: string[] }
			| { readonly status: "cloning" }
			| { readonly status: "error"; readonly message: string },
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
		readonly getCloneStatus: (
			repoId: string,
		) => Effect.Effect<{
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
		 * `{clonePath}/worktrees/pr-{prNumber}`, always checked out on the local
		 * tracking branch `pr-{prNumber}`. The worktree is long-lived: it is NOT
		 * torn down on scope close, on chat clear, or on SHA change. It only
		 * goes away when the PR row is deleted or the repo is removed.
		 *
		 * Lifecycle:
		 *   - **First acquire (no dir on disk):** fetch
		 *     `+refs/pull/N/head:refs/heads/pr-N` from the bare clone, then
		 *     `git worktree add` checks it out at the new branch.
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
	branchName: string,
): Promise<void> {
	const worktreeGitdir = join(clonePath, ".git", "worktrees", branchName);
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
): Promise<void> {
	if (await commitExists(cwd, prHeadSha)) return;

	try {
		await runGit(["fetch", "origin", prHeadSha], cwd);
		if (await commitExists(cwd, prHeadSha)) return;
	} catch (err) {
		debug(
			"pr-worktree",
			`direct SHA fetch failed for ${prHeadSha}, falling back to PR ref:`,
			err instanceof Error ? err.message : String(err),
		);
	}

	await runGit(["fetch", "origin", `refs/pull/${prNumber}/head`], cwd);

	if (!(await commitExists(cwd, prHeadSha))) {
		throw new Error(
			`commit ${prHeadSha} is not available on origin — it may have been force-pushed away or garbage-collected by GitHub`,
		);
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

/**
 * Return every worktree path currently checked out on `refs/heads/<branch>`,
 * parsed from `git worktree list --porcelain`. Used to reclaim `pr-N` when
 * an orphan worktree (e.g. a pre-refactor `chat-{prId}-{sha12}` dir) is
 * squatting on it — leaving such a checkout in place would make any
 * external fetch with a `:refs/heads/pr-N` destination fail. Returns
 * an empty array on parse / spawn failure (best-effort).
 */
async function findWorktreesOnBranch(
	clonePath: string,
	branchName: string,
): Promise<string[]> {
	let out: string;
	try {
		out = await runGitCapture(
			["worktree", "list", "--porcelain"],
			clonePath,
			15_000,
		);
	} catch {
		return [];
	}
	const ref = `refs/heads/${branchName}`;
	const paths: string[] = [];
	// Porcelain output is record-per-blank-line. Each record has lines like:
	//   worktree <path>
	//   HEAD <sha>
	//   branch <ref>     (absent for detached HEADs)
	// We only need (worktree, branch) pairs; everything else we ignore.
	for (const block of out.split("\n\n")) {
		let wtPath: string | null = null;
		let wtBranch: string | null = null;
		for (const line of block.split("\n")) {
			if (line.startsWith("worktree ")) {
				wtPath = line.slice("worktree ".length).trim();
			} else if (line.startsWith("branch ")) {
				wtBranch = line.slice("branch ".length).trim();
			}
		}
		if (wtPath && wtBranch === ref) {
			paths.push(wtPath);
		}
	}
	return paths;
}

/**
 * Count commits reachable from `tip` but not from `base` — i.e., commits
 * above `base` in `tip`'s history. Used to detect unpushed agent commits
 * before advancing a worktree to a new SHA. Returns 0 on any failure.
 */
async function countCommitsAboveSha(
	worktreePath: string,
	base: string,
	tip: string,
): Promise<number> {
	try {
		const out = await runGitCapture(
			["rev-list", "--count", `${base}..${tip}`],
			worktreePath,
		);
		return parseInt(out.trim(), 10) || 0;
	} catch {
		return 0;
	}
}

/**
 * List commits reachable from `tip` but not from `base`.
 * Returns the same shape used in proposed-changes payloads.
 */
async function listCommitsAboveSha(
	worktreePath: string,
	base: string,
	tip: string,
): Promise<
	Array<{
		sha: string;
		shortSha: string;
		subject: string;
		committedAt: string;
		files: string[];
	}>
> {
	try {
		const log = await runGitCapture(
			["log", `${base}..${tip}`, "--pretty=format:%H%x09%s%x09%aI"],
			worktreePath,
		);
		const lines = log.split("\n").filter((l) => l.length > 0);
		if (lines.length === 0) return [];
		const commits: Array<{
			sha: string;
			shortSha: string;
			subject: string;
			committedAt: string;
			files: string[];
		}> = [];
		for (const line of lines) {
			const parts = line.split("\t");
			if (parts.length < 3) continue;
			const sha = parts[0] ?? "";
			const subject = parts[1] ?? "";
			const committedAt = parts[2] ?? "";
			const namesOut = await runGitCapture(
				["diff-tree", "--no-commit-id", "--name-only", "-r", sha],
				worktreePath,
			).catch(() => "");
			const files = namesOut.split("\n").filter((f) => f.length > 0);
			commits.push({ sha, shortSha: sha.slice(0, 7), subject, committedAt, files });
		}
		return commits;
	} catch {
		return [];
	}
}

// ── Live implementation ───────────────────────────────────────────────────────

export const RepoCloneServiceLive = Layer.effect(
	RepoCloneService,
	Effect.gen(function* () {
		const { db } = yield* DbService;
		const wsHub = yield* WebSocketHub;
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

		const cloneRepo = (repo: Repository, githubToken: string): Effect.Effect<void, CloneError> =>
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

				return Effect.gen(function* () {
					const cloneDir = join(CLONE_BASE_DIR, repo.owner, repo.name);
				const gitHost = repo.githubHost;
				const cloneUrl = `https://x-access-token:${githubToken}@${gitHost}/${repo.fullName}.git`;

					debug("repo-clone", `starting clone for ${repo.fullName} -> ${cloneDir}`);

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
								[
									"clone",
								"--depth=1",
								cloneUrl,
									cloneDir,
								],
								CLONE_TIMEOUT_MS,
							);

							// Strip the auth token from the remote URL (security hygiene)
							await runGit(
								[
									"remote",
									"set-url",
									"origin",
									`https://${gitHost}/${repo.fullName}.git`,
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

									debug(
										"repo-clone",
										`clone ready for ${repo.fullName} at ${cloneDir}`,
									);

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

									// Always log clone failures. The route handlers attach
									// `Effect.catchAll(() => Effect.void)` so without this
									// line a clone failure is invisible in server logs —
									// operators only see the silent DB row update and the
									// best-effort WS broadcast (which is lost if the client
									// happens to be disconnected at the moment of failure).
									logError(
										"repo-clone",
										`clone failed for ${repo.fullName}: ${errorMessage}`,
									);

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
				}).pipe(
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

		return {
			cloneRepo,

		acquirePrWorktree: ({ repoId, prNumber, prHeadSha, githubToken }) =>
			Effect.gen(function* () {
				return yield* Effect.tryPromise({
					try: async () => {
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
						const branchName = `pr-${prNumber}`;
						const worktreePath = join(clonePath, "worktrees", branchName);

						const authedUrl = `https://x-access-token:${githubToken}@${gitHost}/${row.fullName}.git`;
						const cleanUrl = `https://${gitHost}/${row.fullName}.git`;

						try {
							// Clear any per-worktree git locks left behind by a
							// SIGTERM'd previous run before any git operation that
							// would block on them. Without this, an aborted Claude
							// Code subprocess can wedge `pr-N`'s worktree gitdir
							// indefinitely; the only known recovery was to remove
							// and re-add the repo.
							await clearStalePrWorktreeLocks(clonePath, branchName);

							// Self-heal a worktree wedged in a mid-merge or
							// mid-rebase state — leftovers of a SIGKILL'd
							// merge-and-push run. Without this, the next
							// `git reset --hard` (lower in this function) trips
							// over `MERGE_HEAD` / `rebase-merge` directories and
							// fails with cryptic errors. Best-effort: a clean
							// worktree no-ops because there's nothing to abort.
							if (existsSync(worktreePath)) {
								await runGitBestEffort(
									["merge", "--abort"],
									worktreePath,
									10_000,
								);
								await runGitBestEffort(
									["rebase", "--abort"],
									worktreePath,
									10_000,
								);
							}

							await runGit(
								["remote", "set-url", "origin", authedUrl],
								clonePath,
							);

							if (existsSync(worktreePath)) {
								// Existing dir — verify it's actually on the expected
								// branch. A wrong-branch / detached / corrupted state
								// means we tear down and recreate; otherwise we move
								// the worktree to `prHeadSha` in place.
								const headRef = await readGitHead(worktreePath);
								if (headRef === `refs/heads/${branchName}`) {
									const currentSha = (
										await runGitCapture(
											["rev-parse", "HEAD"],
											worktreePath,
										)
									).trim();
									if (currentSha === prHeadSha) {
										return { worktreePath, branchName };
									}
								// HEAD has moved past `prHeadSha`. Two distinct
								// shapes hide behind that:
								//
								//   (a) The chat agent committed on top of
								//       `prHeadSha` (no push yet). `currentSha`
								//       is a descendant of `prHeadSha` and those
								//       commits must survive into the next chat
								//       turn — they're what the chat-header push
								//       pill and proposed-changes strip render.
								//   (b) `prHeadSha` itself advanced on the remote
								//       (PR head moved) while we held a stale
								//       snapshot, so the worktree's HEAD has a
								//       different base than the requested
								//       `prHeadSha`. Here we want the old reset
								//       behavior — realign to the new head; any
								//       unpushed agent commits based on the
								//       stale head are discarded by design.
								//
								// `merge-base --is-ancestor prHeadSha currentSha`
								// is exit-0 iff (a) — `prHeadSha` is reachable
								// from `currentSha`. It also exit-0s in the rare
								// fast-forward case where the worktree is
								// somehow already past `prHeadSha` without the
								// agent's involvement, which is still the
								// correct no-op outcome.
								const isAncestor = await runGitBestEffort(
									[
										"merge-base",
										"--is-ancestor",
										prHeadSha,
										currentSha,
									],
									worktreePath,
								);
								if (isAncestor) {
									return { worktreePath, branchName };
								}
								// Pull the requested commit into the local object
								// store. We target `prHeadSha` directly rather than
								// `refs/pull/{N}/head` because the PR's current head
								// can have advanced past `prHeadSha` since metadata
								// was resolved — fetching the ref in that case would
								// pull the wrong objects and the subsequent reset
								// would fail with "Could not parse object". The
								// fetch runs from inside the worktree that owns the
								// branch so the subsequent `reset --hard` updates
								// both working tree and branch ref atomically
								// without tripping git's "refusing to fetch into
								// branch checked out at <path>" guard.
								await ensurePrCommitPresent(
									worktreePath,
									prHeadSha,
									prNumber,
								);
								await runGit(
									["reset", "--hard", prHeadSha],
									worktreePath,
								);
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
							await runGitBestEffort(
								["worktree", "prune"],
								clonePath,
								15_000,
							);

							// Reclaim `refs/heads/pr-N` if some other worktree is
							// squatting on it — e.g. a pre-refactor
							// `chat-…-<sha12>` dir, or any user-created worktree
							// that happened to check out the branch. Without this
							// the fetch below would fail with
							//   "fatal: refusing to fetch into branch
							//    'refs/heads/pr-N' checked out at <other path>"
							// because git refuses to update a branch that's
							// checked out anywhere. We forcibly remove the
							// squatter — it can never be us, since
							// `existsSync(worktreePath)` was false above or we'd
							// have taken the in-place-refresh branch.
							const squatters = await findWorktreesOnBranch(
								clonePath,
								branchName,
							);
							for (const squatter of squatters) {
								if (squatter === worktreePath) continue;
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
										err instanceof Error
											? err.message
											: String(err),
									);
								}
							}
							if (squatters.length > 0) {
								await runGitBestEffort(
									["worktree", "prune"],
									clonePath,
									15_000,
								);
							}

							// Fetch with the branch destination. Safe now because
							// nothing currently has `pr-N` checked out — we just
							// removed any squatter, and a fresh path means no
							// worktree owns it yet. The `+` is the standard
							// force-update prefix used by every fetch refspec
							// in this file.
							await runGit(
								[
									"fetch",
									"origin",
									`+refs/pull/${prNumber}/head:refs/heads/${branchName}`,
								],
								clonePath,
							);
							await runGit(
								["worktree", "add", worktreePath, branchName],
								clonePath,
							);
							// Realign to the caller's requested SHA in case the PR
							// head on GitHub has advanced past it (rare but possible
							// when the caller is acting on a slightly-stale snapshot,
							// e.g. resuming a walkthrough at its original SHA). The
							// PR-ref fetch above only pulls the *current* head, so we
							// have to ensure `prHeadSha` is fetched explicitly before
							// resetting — otherwise reset fails with
							// "Could not parse object".
							const tipSha = (
								await runGitCapture(
									["rev-parse", "HEAD"],
									worktreePath,
								)
							).trim();
							if (tipSha !== prHeadSha) {
								await ensurePrCommitPresent(
									worktreePath,
									prHeadSha,
									prNumber,
								);
								await runGit(
									["reset", "--hard", prHeadSha],
									worktreePath,
								);
							}
							return { worktreePath, branchName };
						} finally {
							await runGit(
								["remote", "set-url", "origin", cleanUrl],
								clonePath,
							);
						}
					},
					catch: (err) => {
						if (err instanceof CloneNotReadyError) return err;
						return new CloneError({
							message: err instanceof Error ? err.message : String(err),
							cause: err,
						});
					},
				})
			}),

		listFilesAtSha: (
			repoId: string,
			prNumber: number,
			headSha: string,
			githubToken: string,
		) =>
			Effect.gen(function* () {
				return yield* Effect.tryPromise({
					try: async () => {
						const row = db
							.select()
							.from(repositories)
							.where(eq(repositories.id, repoId))
							.get();

						if (!row) {
							// Defensive: a missing repo row is effectively the same
							// as a not-yet-cloned repo from the UI's perspective.
							return { status: "cloning" } as const;
						}

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
							// Treat any non-ready terminal state as "cloning" so the UI
							// keeps the placeholder up rather than flipping to a hard
							// error — once the resume-on-boot path settles, it will
							// either succeed or move to 'error' explicitly.
							return { status: "cloning" } as const;
						}

						const gitHost = row.githubHost ?? serverEnv.githubHost;

						// Make sure the exact head SHA is reachable locally. Cheap
						// existence check first; only fetch when we're missing the
						// object. Mirrors the pattern in acquirePrWorktree.
						const hasObject = await runGitBestEffort(
							["cat-file", "-e", `${headSha}^{commit}`],
							clonePath,
							10_000,
						);

						if (!hasObject) {
						const authedUrl = `https://x-access-token:${githubToken}@${gitHost}/${row.fullName}.git`;
						const cleanUrl = `https://${gitHost}/${row.fullName}.git`;

							try {
								await runGit(
									["remote", "set-url", "origin", authedUrl],
									clonePath,
								);
								// Fetch with NO destination ref. We only need the commit
								// object reachable locally — `ls-tree` below uses the raw
								// SHA and never reads `refs/heads/pr-<n>`. Writing into
								// that branch ref would fail when a chat worktree (which
								// checks out `pr-<n>`) is open for the same PR:
								//   "fatal: refusing to fetch into branch
								//    'refs/heads/pr-N' checked out at <chat-worktree>".
								await runGit(
									["fetch", "origin", `refs/pull/${prNumber}/head`],
									clonePath,
								);
							} finally {
								// Always strip the token from the remote URL, even if
								// the fetch failed — security hygiene matches the rest
								// of this file.
								await runGit(
									["remote", "set-url", "origin", cleanUrl],
									clonePath,
								);
							}
						}

						const stdout = await runGitCapture(
							["ls-tree", "-r", "--name-only", headSha],
							clonePath,
						);

						const paths = stdout
							.split("\n")
							.map((line) => line.trim())
							.filter((line) => line.length > 0);

						return { status: "ready", paths } as const;
					},
					catch: (err) =>
					new CloneError({
						message: err instanceof Error ? err.message : String(err),
						cause: err,
					}),
			})
		}),

		getFileContentAtSha: (
				repoId: string,
				headSha: string,
				path: string,
			) =>
				Effect.tryPromise({
					try: async () => {
						const row = db
							.select()
							.from(repositories)
							.where(eq(repositories.id, repoId))
							.get();

						if (!row) return { status: "cloning" } as const;

						if (
							row.cloneStatus === "pending" ||
							row.cloneStatus === "cloning"
						) {
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
							sizeOut = await runGitCapture(
								["cat-file", "-s", objectSpec],
								clonePath,
								30_000,
							);
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

						const content = await runGitCapture(
							["cat-file", "-p", objectSpec],
							clonePath,
							60_000,
						);

						// Binary sniffing — same heuristic as `git diff`: any
						// NUL byte in the first 8 KB flips the verdict. The
						// content string was decoded via TextDecoder
						// (replacement char on invalid UTF-8) so a true binary
						// will both contain ` ` from real NULs *and* lots
						// of U+FFFD; the NUL test alone is sufficient and
						// avoids false positives on valid Unicode replacement
						// characters that happen to be in legitimate text.
						const sniffEnd = Math.min(
							content.length,
							BINARY_SNIFF_SAMPLE_BYTES,
						);
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
					githubHost: repo.githubHost,
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
