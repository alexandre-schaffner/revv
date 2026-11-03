// ── Server build identity ────────────────────────────────────────────────────
//
// The desktop app ships this server compiled inside its bundle, so both come
// from one commit and update together. `/api/health` still reports the
// server's commit: the app compares it with its own to catch a server it
// doesn't own answering on its port (a leftover LaunchAgent, a stale dev
// server), instead of silently running a mismatched UI against it.

// Replaced at compile time by `scripts/build-binary.ts` (`--define`). Absent
// when the server runs from source with `bun run`.
declare const __REVV_BUILD_COMMIT__: string | undefined;

/**
 * Full commit SHA of the source checkout this server runs from, or `null`
 * when it can't be read (no git, or not a git checkout).
 */
export function readSourceCommit(cwd: string = import.meta.dir): string | null {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!result.success) return null;
    const sha = result.stdout.toString().trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

function compiledCommit(): string | null {
  if (typeof __REVV_BUILD_COMMIT__ === "undefined") return null;
  return /^[0-9a-f]{40}$/.test(__REVV_BUILD_COMMIT__) ? __REVV_BUILD_COMMIT__ : null;
}

/** Read once at boot: a running server keeps the code it started with, even if the checkout moves. */
export const SOURCE_COMMIT = compiledCommit() ?? readSourceCommit();
