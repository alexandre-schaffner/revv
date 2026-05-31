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

const legacyAllowlist = new Set([
  "apps/server/src/routes/chat.ts::../services/GitHub",
  "apps/server/src/services/ChatChangesPush.ts::./GitHub",
  "apps/server/src/services/ProjectRecapJobs.ts::./GitHub",
  "apps/server/src/services/ProjectRecapJobs.ts::./Repository",
  "apps/server/src/services/ProjectRecapJobs.ts::./TokenProvider",
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
  if (!featureRoots.some((pattern) => pattern.test(rel))) continue;

  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier || !forbiddenImports.has(specifier)) continue;

    const key = `${rel}::${specifier}`;
    if (!legacyAllowlist.has(key)) {
      violations.push(`${rel} imports ${specifier}`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    "Feature modules must use PrContextService instead of direct GitHub/token/repo services:",
  );
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}
