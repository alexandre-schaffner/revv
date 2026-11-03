// ── Server build identity ────────────────────────────────────────────────────
//
// The desktop app and this server ship separately: the in-app updater swaps
// the `.app` bundle, but the server runs from the source checkout `install.sh`
// cloned (`~/Library/Application Support/Revv/src`), which only `revv update`
// moves. Reporting the checkout's commit on `/api/health` lets the app notice
// when the two have drifted apart, instead of silently running an old server
// under a new UI.

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

/** Read once at boot: a running server keeps the code it started with, even if the checkout moves. */
export const SOURCE_COMMIT = readSourceCommit();
