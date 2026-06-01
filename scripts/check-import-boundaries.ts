import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = import.meta.dir.replace(/\/scripts$/, "");

const featureRoots = [
  /^apps\/server\/src\/services\/WalkthroughJobs\.ts$/,
  /^apps\/server\/src\/routes\/chat(?:-|\.ts)/,
  /^apps\/server\/src\/services\/Chat[A-Za-z].*\.ts$/,
  /^apps\/server\/src\/services\/ProjectRecapJobs\.ts$/,
  /^apps\/server\/src\/services\/recap-[^/]+\.ts$/,
  /^apps\/server\/src\/ai\/providers\/recap(?:-|\/)/,
];

const forbiddenImports = new Set([
  "../services/GitHub",
  "../services/Repository",
  "../services/TokenProvider",
  "./GitHub",
  "./Repository",
  "./TokenProvider",
]);

const identityBoundaryRoots = [
  /^apps\/server\/src\/index\.ts$/,
  /^apps\/server\/src\/routes\/.*\.ts$/,
];

const identityForbiddenImports = new Set([
  "../services/SecretStore",
  "../services/TokenProvider",
  "./services/SecretStore",
  "./services/TokenProvider",
]);

// ── Local Git boundary ──────────────────────────────────────────────────────
// `git-runner` is the raw git-subprocess primitive — an internal of the Local
// Git module. Only the module's own files may spawn git directly; everything
// else must go through `RepoCloneService` (clone + per-job worktrees) or
// `GitOps` (push primitives), which keep worktree acquisition scoped and the
// subprocess registry/signal-handling in one place.
const gitRunnerSpecifierPattern = /(^|\/)git-runner$/;
const gitRunnerAllowedImporters = new Set([
  "apps/server/src/services/RepoClone.ts",
  "apps/server/src/services/GitOps.ts",
]);

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry === "build" || entry === "dist") {
      continue;
    }
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...listTsFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

const importPattern = /import\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g;
const violations: string[] = [];

for (const file of listTsFiles(join(repoRoot, "apps/server/src"))) {
  const rel = relative(repoRoot, file);

  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier) continue;

    if (featureRoots.some((pattern) => pattern.test(rel)) && forbiddenImports.has(specifier)) {
      violations.push(`${rel} imports ${specifier}`);
    }

    if (
      identityBoundaryRoots.some((pattern) => pattern.test(rel)) &&
      identityForbiddenImports.has(specifier)
    ) {
      violations.push(`${rel} imports ${specifier}; use Identity instead`);
    }

    if (gitRunnerSpecifierPattern.test(specifier) && !gitRunnerAllowedImporters.has(rel)) {
      violations.push(
        `${rel} imports ${specifier}; spawn git through RepoCloneService or GitOps, not git-runner directly`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("Import-boundary violations (see docs/architecture.md → Import Direction):");
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}
