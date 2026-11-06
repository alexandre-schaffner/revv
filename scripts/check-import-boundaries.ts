import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const repoRoot = import.meta.dir.replace(/\/scripts$/, "");

const featureRoots = [
  /^apps\/server\/src\/services\/WalkthroughJobs\.ts$/,
  /^apps\/server\/src\/services\/walkthrough-[^/]+\.ts$/,
  /^apps\/server\/src\/services\/walkthrough\//,
  /^apps\/server\/src\/services\/jobs\/agent-jobs\.ts$/,
  /^apps\/server\/src\/routes\/chat(?:-|\.ts)/,
  /^apps\/server\/src\/services\/Chat[A-Za-z].*\.ts$/,
  /^apps\/server\/src\/services\/ProjectRecapJobs\.ts$/,
  /^apps\/server\/src\/services\/recap-[^/]+\.ts$/,
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

// ── GitHub transport boundary ───────────────────────────────────────────────
// Only the GitHub module itself sends requests; everything else calls
// `GitHubGateway` with a client minted by `GitHubAccounts`/`PrContext`, and
// may import the transport's types only.
const githubTransportModule = "apps/server/src/services/github/transport";
const githubModuleDir = "apps/server/src/services/github/";

// ── Git boundary ────────────────────────────────────────────────────────────
// `services/git/` is the one place Revv spawns git: its runner applies the
// policy every git command needs (no prompts, none of the user's hooks or
// signing, a timeout, the process registry, token redaction). Nothing outside
// it may import the runner or spawn git itself. Tests build fixtures with the
// git CLI directly.
const gitModuleDir = "apps/server/src/services/git/";
const gitRunnerModule = "apps/server/src/services/git/runner";
// `build-info.ts` reads the commit of Revv's own source checkout, never a clone.
const gitSpawnAllowed = new Set(["apps/server/src/build-info.ts"]);
const gitSpawnPattern =
  /(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*\[?\s*["'`]git\b|Bun\.spawn(?:Sync)?\(\s*\[\s*["'`]git["'`]/;

// ── Realtime boundary ───────────────────────────────────────────────────────
// `Broadcaster` only moves bytes to connected clients. Features address a push
// through `Realtime`, which resolves the receiving account in one place.
const broadcasterModule = "apps/server/src/services/Broadcaster";
const broadcasterAllowedImporters = new Set([
  "apps/server/src/services/Realtime.ts",
  "apps/server/src/services/AppLayer.ts",
  "apps/server/src/routes/events.ts",
]);

// ── Agent turn boundary ─────────────────────────────────────────────────────
// Every agent turn runs through the turn runner, which owns connect, session,
// deadlines and cancel. Nothing else may reach into the connection pool;
// the boot layer's finalizer stops it at shutdown.
const acpConnectionModule = "apps/server/src/ai/acp/acp-connection";
const acpConnectionAllowedImporters = new Set([
  "apps/server/src/ai/acp/run-turn.ts",
  "apps/server/src/boot.ts",
]);

// ── GSAP boundary ───────────────────────────────────────────────────────────
// Web motion goes through `$lib/motion`, which owns plugin registration, the
// token eases and the reduced-motion contract. Only its GSAP module may import
// the package.
const gsapAllowedImporter = "apps/web/src/lib/motion/gsap.ts";
const gsapImportPattern = /(?:from\s+|import\s*\(\s*|import\s+)["'](gsap(?:\/[^"']*)?)["']/g;

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
    !/\.test\.ts$/.test(rel) &&
    gitSpawnPattern.test(source)
  ) {
    violations.push(`${rel} spawns git; run git through services/git/ops`);
  }
}

for (const file of listTsFiles(join(repoRoot, "apps/web/src"), /\.(ts|svelte)$/)) {
  const rel = relative(repoRoot, file);
  if (rel === gsapAllowedImporter) continue;
  for (const match of readFileSync(file, "utf8").matchAll(gsapImportPattern)) {
    violations.push(`${rel} imports ${match[1]}; animate through $lib/motion`);
  }
}

if (violations.length > 0) {
  console.error("Import-boundary violations (see docs/architecture.md → Import Direction):");
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}
