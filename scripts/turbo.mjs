import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Resolve git metadata before Turbo hashes inputs, including for local builds.
const sha = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
})();
const result = spawnSync(
  fileURLToPath(new URL("../node_modules/.bin/turbo", import.meta.url)),
  process.argv.slice(2),
  {
    stdio: "inherit",
    env: {
      ...process.env,
      REVV_BUILD_SHA: sha,
      REVV_BUILD_RUNTIME: `${process.platform}-${process.arch}-bun-${process.versions.bun}`,
    },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
