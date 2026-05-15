// ── git-runner ─────────────────────────────────────────────────────────────
//
// Shared subprocess runner for git commands. Owns:
//   - GIT_ENV — env scrubbing that stops git from blocking on prompts
//   - the active-process registry + signal handlers (so SIGTERM/SIGINT
//     etc. don't leave orphan git processes)
//   - spawnGit / runGit / runGitCapture / runGitBestEffort — every helper
//     that wraps subprocess I/O with timeout + drain semantics
//   - killStaleCloneProcesses — boot-time orphan reaper
//
// Internal-only. Imported by `RepoClone.ts` (clones, worktrees, file reads)
// and `ChatChangesPush.ts` (merge-and-push). Both share one process registry
// so a single SIGTERM cleans up everything regardless of which service
// spawned the process.

import { serverEnv } from "../config";

// ── Environment ──────────────────────────────────────────────────────────────

/**
 * Environment overrides applied to every git subprocess. These prevent git
 * from blocking on interactive prompts — critical in the production LaunchAgent
 * where there is no TTY and a hanging credential helper would freeze the job.
 */
const GIT_ENV: Record<string, string> = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "echo",
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
type SpawnedProc = ReturnType<typeof Bun.spawn> & {
  exited: Promise<number>;
  pid: number;
  kill: (sig?: number | string) => void;
};
const activeProcs = new Set<SpawnedProc>();

let signalHandlersInstalled = false;
export function ensureSignalHandlersInstalled(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const killAll = () => {
    for (const proc of activeProcs) {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
    // Grace period before escalating SIGTERM -> SIGKILL on process shutdown.
    const SIGKILL_GRACE_MS = 2_000;
    setTimeout(() => {
      for (const proc of activeProcs) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }, SIGKILL_GRACE_MS).unref?.();
  };
  process.once("SIGTERM", killAll);
  process.once("SIGINT", killAll);
  process.once("SIGHUP", killAll);
  process.once("beforeExit", killAll);
}

// ── Subprocess runners ───────────────────────────────────────────────────────

/**
 * Spawn `git ...args` and wait for it under a hard timeout. On timeout we
 * send SIGTERM, then escalate to SIGKILL after a grace period; both stdout
 * and stderr are drained concurrently so the OS pipe buffer never fills
 * (which would block git on `write()` and make the wait look like a hang).
 *
 * Returns the captured stderr tail and exit code so callers can build their
 * own error messages without having to consume the streams themselves.
 */
export async function spawnGit(
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs: number;
    captureStdout?: boolean;
    env?: Record<string, string>;
  },
): Promise<{ exitCode: number; stdout: string; stderrTail: string; timedOut: boolean }> {
  ensureSignalHandlersInstalled();

  const proc = Bun.spawn(["git", ...args], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    stdout: opts.captureStdout ? "pipe" : "ignore",
    stderr: "pipe",
    stdin: "ignore",
    env: opts.env ?? GIT_ENV,
  }) as unknown as SpawnedProc;

  activeProcs.add(proc);

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
    } catch {
      /* stream closed by kill — fine */
    }
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
        } catch {
          /* stream closed by kill — fine */
        }
      })()
    : Promise.resolve();

  let timedOut = false;
  let killEscalation: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    killEscalation = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, 5_000);
    killEscalation.unref?.();
  }, opts.timeoutMs);

  try {
    await proc.exited;
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

export async function runGit(args: string[], cwd?: string, timeoutMs = 120_000): Promise<void> {
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
export async function runGitCapture(
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
export async function runGitCloneWithTimeout(args: string[], timeoutMs: number): Promise<void> {
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
export async function runGitBestEffort(
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
export async function killStaleCloneProcesses(): Promise<void> {
  try {
    const escaped = serverEnv.cloneDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const proc = Bun.spawn(
      ["pkill", "-TERM", "-f", `git (clone|fetch|index-pack|remote-https).*${escaped}`],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* noop */
      }
    }, 5_000);
    await proc.exited;
    clearTimeout(timer);
  } catch {
    // pkill missing on this OS or otherwise unavailable — nothing we can do.
  }
}
