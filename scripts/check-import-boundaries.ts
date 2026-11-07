import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const repoRoot = import.meta.dir.replace(/\/scripts$/, "");

const featureRoots = [
  /^apps\/server\/src\/services\/walkthrough\//,
  /^apps\/server\/src\/services\/hunk-scan\//,
  /^apps\/server\/src\/services\/jobs\//,
  /^apps\/server\/src\/routes\/chat(?:-|\.ts)/,
  /^apps\/server\/src\/services\/chat\//,
  /^apps\/server\/src\/services\/workspace\//,
  /^apps\/server\/src\/services\/base-conflicts\//,
  /^apps\/server\/src\/services\/recaps\/(?:ProjectRecapJobs|request|source-bundle)\.ts$/,
  /^apps\/server\/src\/ai\/providers\/recap(?:-|\/)/,
  /^apps\/server\/src\/services\/stacks\/(?:StackBriefJobs|StackReview)\.ts$/,
  /^apps\/server\/src\/ai\/providers\/stack-brief(?:-|\/)/,
];

// Feature pipelines call GitHub only with the client `PrContext` hands them for
// the repository's owning account: they may not mint one, nor read repositories
// around it.
const forbiddenImports = new Set([
  "apps/server/src/services/github/accounts",
  "apps/server/src/services/Repository",
]);

const identityBoundaryRoots = [
  /^apps\/server\/src\/index\.ts$/,
  /^apps\/server\/src\/routes\/.*\.ts$/,
];

const identityForbiddenImports = new Set(["apps/server/src/services/SecretStore"]);

// Only the GitHub module itself sends requests; everything else calls
// `GitHubGateway` with a client minted by `GitHubAccounts`/`PrContext`, and
// may import the transport's types only.
const githubTransportModule = "apps/server/src/services/github/transport";
const githubModuleDir = "apps/server/src/services/github/";

// `services/git/` is the one place Revv spawns git: its runner applies the
// policy every git command needs (no prompts, none of the user's hooks,
// signing per `GitPolicy`, a timeout, the process registry, token redaction). Nothing outside
// it may import the runner or spawn git itself. Tests (and their
// `*-test-support.ts` helpers) build fixtures with the git CLI directly.
const gitModuleDir = "apps/server/src/services/git/";
const gitRunnerModule = "apps/server/src/services/git/runner";
// `build-info.ts` reads the commit of Revv's own source checkout, never a clone.
const gitSpawnAllowed = new Set(["apps/server/src/build-info.ts"]);
const gitSpawnPattern =
  /(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*\[?\s*["'`]git\b|Bun\.spawn(?:Sync)?\(\s*\[\s*["'`]git["'`]/;

// `Broadcaster` only moves bytes to connected clients. Features address a push
// through `Realtime`, which resolves the receiving account in one place.
const broadcasterModule = "apps/server/src/services/Broadcaster";
const broadcasterAllowedImporters = new Set([
  "apps/server/src/services/Realtime.ts",
  "apps/server/src/services/AppLayer.ts",
  "apps/server/src/routes/events.ts",
]);

// Every agent turn runs through the turn runner, which owns connect, session,
// deadlines and cancel. Nothing else may reach into the connection pool;
// the boot layer's finalizer stops it at shutdown.
const acpConnectionModule = "apps/server/src/ai/acp/acp-connection";
const acpConnectionAllowedImporters = new Set([
  "apps/server/src/ai/acp/run-turn.ts",
  "apps/server/src/boot.ts",
]);

// Web motion goes through `$lib/motion`, which owns plugin registration, the
// token eases and the reduced-motion contract. Only its GSAP module may import
// the package.
const gsapAllowedImporter = "apps/web/src/lib/motion/gsap.ts";
const gsapImportPattern = /(?:from\s+|import\s*\(\s*|import\s+)["'](gsap(?:\/[^"']*)?)["']/g;

// Web layering: components render what lib/ (stores, features, utilities)
// provides, so nothing in lib/ outside components/ may import a component
// module; and stores sit below the session lifecycle, which resets them.
const webLibDir = "apps/web/src/lib/";
const webComponentsDir = "apps/web/src/lib/components/";
const webStoresDir = "apps/web/src/lib/stores/";
const webSessionLifecycle = "apps/web/src/lib/session/lifecycle.svelte";
const webImportPattern = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

function resolveWebImport(importerRel: string, specifier: string): string | null {
  const path = specifier.startsWith("$lib/")
    ? `${webLibDir}${specifier.slice("$lib/".length)}`
    : specifier.startsWith(".")
      ? join(dirname(importerRel), specifier)
      : null;
  return path?.replace(/\.(?:ts|js)$/, "") ?? null;
}

function listTsFiles(dir: string, extensions = /\.(ts|tsx)$/): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry === "build" || entry === "dist") {
      continue;
    }
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...listTsFiles(path, extensions));
    } else if (extensions.test(entry)) {
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
      violations.push(`${rel} imports ${specifier}; go through GitHubAccounts`);
    }

    if (
      target === broadcasterModule &&
      !broadcasterAllowedImporters.has(rel) &&
      !/\.test\.ts$/.test(rel)
    ) {
      violations.push(`${rel} imports ${specifier}; send pushes through Realtime`);
    }

    if (
      target === acpConnectionModule &&
      !acpConnectionAllowedImporters.has(rel) &&
      !/\.test\.ts$/.test(rel)
    ) {
      violations.push(`${rel} imports ${specifier}; run agent turns through ai/acp/run-turn`);
    }

    const typeOnly = /^import\s+type\b/.test(match[0]);
    if (
      target === githubTransportModule &&
      !typeOnly &&
      !rel.startsWith(githubModuleDir) &&
      !/\.test\.ts$/.test(rel)
    ) {
      violations.push(`${rel} imports ${specifier}; call GitHub through GitHubGateway`);
    }

    if (target === gitRunnerModule && !rel.startsWith(gitModuleDir)) {
      violations.push(`${rel} imports ${specifier}; run git through services/git/ops`);
    }
  }

  if (
    !rel.startsWith(gitModuleDir) &&
    !gitSpawnAllowed.has(rel) &&
    !/(?:\.test|-test-support)\.ts$/.test(rel) &&
    gitSpawnPattern.test(source)
  ) {
    violations.push(`${rel} spawns git; run git through services/git/ops`);
  }
}

for (const file of listTsFiles(join(repoRoot, "apps/web/src"), /\.(ts|svelte)$/)) {
  const rel = relative(repoRoot, file);
  const source = readFileSync(file, "utf8");
  if (rel !== gsapAllowedImporter) {
    for (const match of source.matchAll(gsapImportPattern)) {
      violations.push(`${rel} imports ${match[1]}; animate through $lib/motion`);
    }
  }

  for (const match of source.matchAll(webImportPattern)) {
    const specifier = match[1];
    if (!specifier) continue;
    const target = resolveWebImport(rel, specifier);
    if (target === null) continue;

    if (
      rel.startsWith(webLibDir) &&
      !rel.startsWith(webComponentsDir) &&
      target.startsWith(webComponentsDir)
    ) {
      violations.push(`${rel} imports ${specifier}; lib/ modules sit below components/`);
    }

    if (rel.startsWith(webStoresDir) && target === webSessionLifecycle) {
      violations.push(`${rel} imports ${specifier}; stores sit below the session lifecycle`);
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
