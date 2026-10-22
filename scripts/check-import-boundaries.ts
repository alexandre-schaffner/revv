import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const repoRoot = import.meta.dir.replace(/\/scripts$/, "");

const featureRoots = [
  /^apps\/server\/src\/services\/WalkthroughJobs\.ts$/,
  /^apps\/server\/src\/services\/walkthrough-[^/]+\.ts$/,
  /^apps\/server\/src\/routes\/chat(?:-|\.ts)/,
  /^apps\/server\/src\/services\/Chat[A-Za-z].*\.ts$/,
  /^apps\/server\/src\/services\/ProjectRecapJobs\.ts$/,
  /^apps\/server\/src\/services\/recap-[^/]+\.ts$/,
  /^apps\/server\/src\/ai\/providers\/recap(?:-|\/)/,
  /^apps\/server\/src\/services\/stacks\/(?:StackBriefJobs|StackReview)\.ts$/,
  /^apps\/server\/src\/ai\/providers\/stack-brief(?:-|\/)/,
];

const forbiddenImports = new Set([
  "apps/server/src/services/GitHub",
  "apps/server/src/services/Repository",
  "apps/server/src/services/TokenProvider",
]);

const identityBoundaryRoots = [
  /^apps\/server\/src\/index\.ts$/,
  /^apps\/server\/src\/routes\/.*\.ts$/,
];

const identityForbiddenImports = new Set([
  "apps/server/src/services/SecretStore",
  "apps/server/src/services/TokenProvider",
]);

// ── Local Git boundary ──────────────────────────────────────────────────────
// `git-runner` is the raw git-subprocess primitive — an internal of the Local
// Git module. Only the module's own files may spawn git directly; everything
// else must go through `RepoCloneService` (clone + per-job worktrees) or
// `GitOps` (git command primitives), which keep worktree acquisition scoped
// and the subprocess registry/signal-handling in one place. `clone-policy` is
// `RepoCloneService`'s own read-only inspection/policy helper, so it sits
// inside the module boundary too.
const gitRunnerModule = "apps/server/src/services/git-runner";
const gitRunnerAllowedImporters = new Set([
  "apps/server/src/services/RepoClone.ts",
  "apps/server/src/services/clone-policy.ts",
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

function resolveImport(importerRel: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return join(dirname(importerRel), specifier)
    .replace(/\.(?:ts|tsx|js)$/, "")
    .replace(/\/index$/, "");
}

const importPattern = /import\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g;
const violations: string[] = [];

for (const file of listTsFiles(join(repoRoot, "apps/server/src"))) {
  const rel = relative(repoRoot, file);

  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier) continue;
    const target = resolveImport(rel, specifier);
    if (target === null) continue;

    if (featureRoots.some((pattern) => pattern.test(rel)) && forbiddenImports.has(target)) {
      violations.push(`${rel} imports ${specifier}`);
    }

    if (
      identityBoundaryRoots.some((pattern) => pattern.test(rel)) &&
      identityForbiddenImports.has(target)
    ) {
      violations.push(`${rel} imports ${specifier}; use Identity instead`);
    }

    if (target === gitRunnerModule && !gitRunnerAllowedImporters.has(rel)) {
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
