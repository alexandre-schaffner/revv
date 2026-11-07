// The one place Revv spawns git. Every command gets the same policy:
//
//   - `GIT_ENV`: nothing may prompt. The server has no TTY, so a credential
//     helper or signer waiting for input would freeze the job.
//   - `core.hooksPath=/dev/null`: the user's hooks never run. Revv's clones are
//     often the user's own repository; their husky post-checkout or pre-push
//     test run is theirs to trigger.
//   - commit signing per `GitPolicy`: off, unless the command writes commits
//     that are pushed to the user's branches, which follow their own
//     `commit.gpgSign`. A signer that needs a prompt can't get one, so it fails
//     (or hits the timeout) and its stderr says why.
//   - a hard timeout, SIGTERM then SIGKILL;
//   - registration in `activeProcs`, so a server shutdown kills every git
//     process it started ({@link killRunningGitProcesses}; orphaned `git clone`s
//     otherwise fight the next lifetime for `.git/shallow.lock` and write into
//     directories it removed);
//   - stderr redaction, so a token echoed from an authed URL never leaves.
//
// Private to `services/git/`; `scripts/check-import-boundaries.ts` enforces it.

import { redactGitAuth } from "./remote";

const { GPG_TTY: _gpgTty, ...inherited } = process.env;
const GIT_ENV: Record<string, string> = {
  ...inherited,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "echo",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=no",
  // An SSH signing key's passphrase may not be asked for through askpass.
  SSH_ASKPASS_REQUIRE: "never",
} as Record<string, string>;

export interface GitPolicy {
  /** `user`: commits this command writes follow the user's `commit.gpgSign`. */
  readonly signing: "off" | "user";
}

const UNSIGNED: GitPolicy = { signing: "off" };

const policyConfig = (policy: GitPolicy): string[] => [
  "-c",
  "core.hooksPath=/dev/null",
  ...(policy.signing === "off" ? ["-c", "commit.gpgSign=false"] : []),
];

const STDERR_TAIL_CHARS = 16_384;

type SpawnedProc = ReturnType<typeof Bun.spawn> & {
  exited: Promise<number>;
  pid: number;
  kill: (sig?: number | string) => void;
};
const activeProcs = new Set<SpawnedProc>();

/**
 * SIGTERM every git process this server started, then SIGKILL what is left.
 * The runtime's owner calls it on shutdown.
 */
export function killRunningGitProcesses(): void {
  for (const proc of activeProcs) {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }
  setTimeout(() => {
    for (const proc of activeProcs) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }, 2_000).unref?.();
}

/** The outcome of one git command. `stderr` is redacted. */
export interface GitAttempt {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Thrown by {@link runGit}; `message` is redacted. */
export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly attempt: GitAttempt,
    timeoutMs: number,
  ) {
    super(
      attempt.timedOut
        ? `git ${args[0]} timed out after ${timeoutMs / 1000}s` +
            (attempt.stderr ? `; tail: ${attempt.stderr.slice(-512)}` : "")
        : `git ${args[0]} failed: ${attempt.stderr}`,
    );
  }
}

async function drain(stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void) {
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }
  } catch {
    /* closed by kill */
  }
}

/**
 * Run `git ...args` and report how it went; never throws. Both pipes are
 * drained concurrently so a full pipe buffer never blocks git on `write()`.
 */
export async function gitAttempt(
  cwd: string | undefined,
  args: readonly string[],
  timeoutMs: number,
  policy: GitPolicy = UNSIGNED,
): Promise<GitAttempt> {
  let proc: SpawnedProc;
  try {
    proc = Bun.spawn(["git", ...policyConfig(policy), ...args], {
      ...(cwd !== undefined ? { cwd } : {}),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: GIT_ENV,
    }) as unknown as SpawnedProc;
  } catch (err) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: redactGitAuth(err instanceof Error ? err.message : String(err)),
      timedOut: false,
    };
  }
  activeProcs.add(proc);

  let stderr = "";
  let stdout = "";
  const drains = Promise.allSettled([
    drain(proc.stderr as ReadableStream<Uint8Array>, (text) => {
      stderr += text;
      if (stderr.length > STDERR_TAIL_CHARS) stderr = stderr.slice(-STDERR_TAIL_CHARS);
    }),
    drain(proc.stdout as ReadableStream<Uint8Array>, (text) => {
      stdout += text;
    }),
  ]);

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
  }, timeoutMs);

  try {
    await proc.exited;
    await drains;
    const exitCode = proc.exitCode ?? -1;
    return {
      ok: exitCode === 0 && !timedOut,
      exitCode,
      stdout,
      stderr: redactGitAuth(stderr.trim()),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
    if (killEscalation) clearTimeout(killEscalation);
    activeProcs.delete(proc);
  }
}

/** Run a git command that must succeed; returns its stdout, throws {@link GitCommandError}. */
export async function runGit(
  cwd: string | undefined,
  args: readonly string[],
  timeoutMs = 120_000,
): Promise<string> {
  const attempt = await gitAttempt(cwd, args, timeoutMs);
  if (!attempt.ok) throw new GitCommandError(args, attempt, timeoutMs);
  return attempt.stdout;
}

/** Whether a git command succeeded; for probes and cleanup that must never fail their caller. */
export async function gitSucceeds(
  cwd: string,
  args: readonly string[],
  timeoutMs = 10_000,
): Promise<boolean> {
  return (await gitAttempt(cwd, args, timeoutMs)).ok;
}

/** Kill the git transfers an earlier server left running in `dir`. */
export async function killStaleGitTransfers(dir: string): Promise<void> {
  try {
    const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    /* pkill unavailable */
  }
}
