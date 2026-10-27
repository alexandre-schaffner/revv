// ── Package-runner working directory ─────────────────────────────────────────
//
// Most ACP adapters are launched through a package runner (`npx -y <adapter>`,
// or `bunx` when npm is missing). A package runner is not a neutral launcher:
// `npm exec` loads the dependency tree of the project it runs in, so spawning
// it inside a PR worktree makes npm parse the REVIEWED repo's `package.json`.
// A repo npm can't read (Bun's `catalog:` protocol alongside `overrides`, say)
// makes npm exit before the adapter starts, and every review, chat and recap
// in that repo fails with "ACP connection closed".
//
// So the runner is spawned from this Revv-owned directory instead. Its own
// `package.json` stops npm's walk up for a project root, so no parent
// directory's manifest is read either. The worktree still reaches the agent as
// the ACP session `cwd`, which is where adapters run tools and read project
// settings. Changing the runner's `--prefix` instead would leak
// `npm_config_prefix` into the agent, and redirect every `npm install` the
// agent runs.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logError } from "../../logger";

const PACKAGE_RUNNER_DIR = join(homedir(), ".revv", "acp-runner");

/**
 * Create the package-runner directory if needed and return it, or `null` when
 * it can't be created (the caller then falls back to the worktree).
 */
export function ensurePackageRunnerDir(dir: string = PACKAGE_RUNNER_DIR): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) {
      writeFileSync(manifest, `${JSON.stringify({ name: "revv-acp-runner", private: true })}\n`);
    }
    return dir;
  } catch (err) {
    logError(
      "package-runner-dir",
      "failed to prepare the package-runner directory:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
