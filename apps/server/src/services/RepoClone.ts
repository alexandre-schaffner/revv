import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { CloneStatus, Repository } from "@revv/shared";
import { eq, or } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
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
			CloneError | CloneNotReadyError
		>;
	}
>() {}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Spawn a git command and wait for it, throwing if it exits non-zero or times out. */
// Environment overrides applied to every git subprocess. These prevent git
// from blocking on interactive prompts — critical in the production LaunchAgent
// where there is no TTY and a hanging credential helper would freeze the job.
const GIT_ENV: Record<string, string> = {
	...process.env,
	GIT_TERMINAL_PROMPT: "0",   // never prompt for credentials
	GIT_ASKPASS: "echo",         // answer any askpass with an empty string
	GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=no",
} as Record<string, string>;

// ── Subprocess registry + signal handlers ────────────────────────────────────
//
// Every git process we spawn is registered here so we can kill them all when
// the server shuts down. Without this, ctrl-C / SIGTERM / `bun --watch`
// reload leaves orphan `git clone` processes running indefinitely — they
// hold open FDs against directories we then `rm -rf` for the next attempt,
// they fight each other for `.git/shallow.lock`, and they accumulate across
// dev-server restarts until the user kills them by hand. This registry plus
// signal-driven cleanup is what prevents that.
//
// In-memory only by design: per CLAUDE.md the orchestrator's coordination
// caches are reconstructible from SQLite. On boot we additionally pkill any
// lingering orphans (see `killStaleCloneProcesses`) so the cache starts
// empty regardless of how the previous process died.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpawnedProc = ReturnType<typeof Bun.spawn> & { exited: Promise<number>; pid: number; kill: (sig?: number | string) => void };
const activeProcs = new Set<SpawnedProc>();

let signalHandlersInstalled = false;
function ensureSignalHandlersInstalled(): void {
	if (signalHandlersInstalled) return;
	signalHandlersInstalled = true;
	const killAll = () => {
		for (const proc of activeProcs) {
			try { proc.kill("SIGTERM"); } catch { /* already dead */ }
		}
		// Escalate after a brief grace period — git in `index-pack` can swallow
		// SIGTERM during pack-writing. We don't await; the process is exiting
		// anyway, this is just so children don't outlive us.
		setTimeout(() => {
			for (const proc of activeProcs) {
				try { proc.kill("SIGKILL"); } catch { /* already dead */ }
			}
		}, 2_000).unref?.();
	};
	process.once("SIGTERM", killAll);
	process.once("SIGINT", killAll);
	process.once("SIGHUP", killAll);
	// `beforeExit` fires when the event loop empties; useful for clean exits
	// (e.g. test harness, normal shutdown). Won't fire on hard signals — the
	// signal handlers above cover those.
	process.once("beforeExit", killAll);
}

/**
 * Spawn `git ...args` and wait for it under a hard timeout. On timeout we
 * send SIGTERM, then escalate to SIGKILL after a grace period; both stdout
 * and stderr are drained concurrently so the OS pipe buffer never fills
 * (which would block git on `write()` and make the wait look like a hang).
 *
 * Returns the captured stderr tail and exit code so callers can build their
 * own error messages without having to consume the streams themselves.
 */
async function spawnGit(
	args: string[],
	opts: {
		cwd?: string;
		timeoutMs: number;
		captureStdout?: boolean;
	},
): Promise<{ exitCode: number; stdout: string; stderrTail: string; timedOut: boolean }> {
	ensureSignalHandlersInstalled();

	const proc = Bun.spawn(["git", ...args], {
		...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
		stdout: opts.captureStdout ? "pipe" : "ignore",
		stderr: "pipe",
		stdin: "ignore",
		env: GIT_ENV,
	}) as unknown as SpawnedProc;

	activeProcs.add(proc);

	// Drain stderr into a 16KB ring so the pipe never blocks. Keep the tail
	// for error messages — clone progress is verbose, head is just
	// "Cloning into …" which we don't need.
	let stderrTail = "";
	const stderrDrain = (async () => {
		try {
			const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				stderrTail += decoder.decode(value, { stream: true });
				if (stderrTail.length > 16_384) {
					stderrTail = stderrTail.slice(-16_384);
				}
			}
		} catch { /* stream closed by kill — fine */ }
	})();

	let stdout = "";
	const stdoutDrain = opts.captureStdout
		? (async () => {
			try {
				const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
				const decoder = new TextDecoder();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					stdout += decoder.decode(value, { stream: true });
				}
			} catch { /* stream closed by kill — fine */ }
		})()
		: Promise.resolve();

	let timedOut = false;
	let killEscalation: ReturnType<typeof setTimeout> | undefined;
	const timer = setTimeout(() => {
		timedOut = true;
		try { proc.kill("SIGTERM"); } catch { /* already dead */ }
		// Escalate to SIGKILL if SIGTERM doesn't take effect within 5s. git's
		// pack-writing critical section can swallow SIGTERM until it finishes
		// the current object — without escalation that wait is unbounded.
		killEscalation = setTimeout(() => {
			try { proc.kill("SIGKILL"); } catch { /* already dead */ }
		}, 5_000);
		killEscalation.unref?.();
	}, opts.timeoutMs);

	try {
		await proc.exited;
		// Drains resolve when the OS closes the streams, which happens when
		// the process exits. Safe to await unconditionally.
		await Promise.allSettled([stderrDrain, stdoutDrain]);
		return {
			exitCode: proc.exitCode ?? -1,
			stdout,
			stderrTail: stderrTail.trim(),
			timedOut,
		};
	} finally {
		clearTimeout(timer);
		if (killEscalation) clearTimeout(killEscalation);
		activeProcs.delete(proc);
	}
}

async function runGit(
	args: string[],
	cwd?: string,
	timeoutMs = 120_000,
): Promise<void> {
	const result = await spawnGit(args, {
		...(cwd !== undefined ? { cwd } : {}),
		timeoutMs,
	});
	if (result.timedOut) {
		throw new Error(
			`git ${args[0]} timed out after ${timeoutMs / 1000}s` +
			(result.stderrTail ? `; tail: ${result.stderrTail.slice(-512)}` : ""),
		);
	}
	if (result.exitCode !== 0) {
		throw new Error(`git ${args[0]} failed: ${result.stderrTail}`);
	}
}

/**
 * Run a git command and return its stdout. Same timeout/error semantics as
 * {@link runGit}, but reads stdout into a string. Used for read-only commands
 * (`ls-tree`, `rev-parse`, etc.) where the output is the whole point.
 */
async function runGitCapture(
	args: string[],
	cwd: string,
	timeoutMs = 60_000,
): Promise<string> {
	const result = await spawnGit(args, { cwd, timeoutMs, captureStdout: true });
	if (result.timedOut) {
		throw new Error(
			`git ${args[0]} timed out after ${timeoutMs / 1000}s` +
			(result.stderrTail ? `; tail: ${result.stderrTail.slice(-512)}` : ""),
		);
	}
	if (result.exitCode !== 0) {
		throw new Error(`git ${args[0]} failed: ${result.stderrTail}`);
	}
	return result.stdout;
}

/** Race a git clone against a timeout, killing the process if it exceeds the limit. */
async function runGitCloneWithTimeout(
	args: string[],
	timeoutMs: number,
): Promise<void> {
	const result = await spawnGit(args, { timeoutMs });
	if (result.timedOut) {
		throw new Error(
			`git clone timed out after ${timeoutMs / 1000}s` +
			(result.stderrTail ? `; tail: ${result.stderrTail.slice(-512)}` : ""),
		);
	}
	if (result.exitCode !== 0) {
		throw new Error(`git clone failed: ${result.stderrTail}`);
	}
}

/**
 * Fire-and-forget git subprocess with a hard timeout. Used for cleanup
 * operations where we never want to block — errors and non-zero exits are
 * silently swallowed. Returns true if the process exited 0 within the budget.
 */
async function runGitBestEffort(
	args: string[],
	cwd: string,
	timeoutMs = 10_000,
): Promise<boolean> {
	try {
		const result = await spawnGit(args, { cwd, timeoutMs });
		return !result.timedOut && result.exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Boot-time orphan reaper. Kill any `git clone`, `git fetch`, or
 * `git index-pack` process whose command line references our clone base
 * directory. These are processes spawned by a previous server lifetime that
 * outlived their parent — the OS kept them as orphans, and they will fight
 * the current lifetime for `.git/shallow.lock`, write to `rm`'d directories
 * via still-open FDs, and generally make the next clone hang.
 *
 * macOS / Linux only. Best-effort: missing pkill, permission errors, or no
 * matching processes are all silently ignored.
 */
async function killStaleCloneProcesses(): Promise<void> {
	try {
		// `pkill -f <pattern>` matches the full command line. Pattern is escaped
		// just enough that a clone path containing regex specials doesn't blow
		// it up — the clone dir is under $HOME so it's nearly always literal,
		// but defense in depth never hurts.
		const escaped = CLONE_BASE_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const proc = Bun.spawn(
			[
				"pkill",
				"-TERM",
				"-f",
				`git (clone|fetch|index-pack|remote-https).*${escaped}`,
			],
			{ stdout: "ignore", stderr: "ignore", stdin: "ignore" },
		);
		// pkill exits 0 if it killed something, 1 if no match — both are fine.
		const timer = setTimeout(() => {
			try { proc.kill(); } catch { /* noop */ }
		}, 5_000);
		await proc.exited;
		clearTimeout(timer);
	} catch {
		// pkill missing on this OS or otherwise unavailable — nothing we can do.
	}
}

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
					const cloneUrl = `https://x-access-token:${githubToken}@${GITHUB_HOST}/${repo.fullName}.git`;

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
									"--no-single-branch",
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
				Effect.tryPromise({
					try: async () => {
						const row = db
							.select()
							.from(repositories)
							.where(eq(repositories.id, repoId))
							.get();

						if (!row || row.cloneStatus !== "ready" || !row.clonePath) {
							throw new CloneNotReadyError({ repoId });
						}

						const clonePath = row.clonePath;
						const branchName = `pr-${prNumber}`;
						const worktreePath = join(clonePath, "worktrees", branchName);

						const authedUrl = `https://x-access-token:${githubToken}@${GITHUB_HOST}/${row.fullName}.git`;
						const cleanUrl = `https://${GITHUB_HOST}/${row.fullName}.git`;

						try {
							// Clear any per-worktree git locks left behind by a
							// SIGTERM'd previous run before any git operation that
							// would block on them. Without this, an aborted Claude
							// Code subprocess can wedge `pr-N`'s worktree gitdir
							// indefinitely; the only known recovery was to remove
							// and re-add the repo.
							await clearStalePrWorktreeLocks(clonePath, branchName);

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
				}),

			listFilesAtSha: (
				repoId: string,
				prNumber: number,
				headSha: string,
				githubToken: string,
			) =>
				Effect.tryPromise({
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

						// Make sure the exact head SHA is reachable locally. Cheap
						// existence check first; only fetch when we're missing the
						// object. Mirrors the pattern in acquirePrWorktree.
						const hasObject = await runGitBestEffort(
							["cat-file", "-e", `${headSha}^{commit}`],
							clonePath,
							10_000,
						);

						if (!hasObject) {
							const authedUrl = `https://x-access-token:${githubToken}@${GITHUB_HOST}/${row.fullName}.git`;
							const cleanUrl = `https://${GITHUB_HOST}/${row.fullName}.git`;

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
