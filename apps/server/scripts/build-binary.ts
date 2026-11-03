// Compile the server into the standalone executable the desktop app bundles
// (`Revv.app/Contents/MacOS/revv-server`). Run by Tauri's `beforeBuildCommand`,
// which exports the target triple being built.
//
//   bun apps/server/scripts/build-binary.ts [target-triple]

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const BUN_TARGETS: Record<string, { bun: string; arch: string }> = {
  "aarch64-apple-darwin": { bun: "bun-darwin-arm64", arch: "arm64" },
  // Baseline avoids AVX2, which Intel Macs older than 2013 lack.
  "x86_64-apple-darwin": { bun: "bun-darwin-x64-baseline", arch: "x64" },
};

const serverDir = resolve(import.meta.dir, "..");
const outfile = resolve(serverDir, "../desktop/target/revv-server/revv-server");

const triple = process.argv[2] ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple();
const target = BUN_TARGETS[triple];
if (!target) {
  throw new Error(`Unsupported desktop target: ${triple}`);
}

// The keyring addon is a per-arch optional dependency that `bun install`
// fetches only for the host. Cross-compiling needs the target's copy:
//   bun install --frozen-lockfile --cpu='*' --os=darwin
const keyring = `@napi-rs/keyring-darwin-${target.arch}`;
try {
  const fromServer = createRequire(join(serverDir, "package.json"));
  createRequire(fromServer.resolve("@napi-rs/keyring")).resolve(keyring);
} catch {
  throw new Error(
    `${keyring} is not installed. Run: bun install --frozen-lockfile --cpu='*' --os=darwin`,
  );
}

const commit = process.env.REVV_BUILD_SHA || git(["rev-parse", "HEAD"]);
if (!/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error(`Expected a full commit SHA, got "${commit}"`);
}

mkdirSync(resolve(outfile, ".."), { recursive: true });
const result = await Bun.build({
  entrypoints: [join(serverDir, "src/index.ts")],
  compile: {
    target: target.bun as Bun.Build.CompileTarget,
    outfile,
    // Embedded beside the entrypoint (`/$bunfs/root/<name>`), where
    // `db/index.ts` and `findIntegrationsDirectory()` look for them.
    assets: [join(serverDir, "src/db/migrations"), resolve(serverDir, "../../integrations")],
    // Configuration comes from the desktop app's environment, never from
    // files in whatever directory the server happens to start in.
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  define: { __REVV_BUILD_COMMIT__: JSON.stringify(commit) },
  minify: { syntax: true, whitespace: true },
  sourcemap: "inline",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`Compiled ${outfile} (${triple}, ${commit.slice(0, 7)})`);

function hostTriple(): string {
  return `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: serverDir, encoding: "utf8" }).trim();
}
