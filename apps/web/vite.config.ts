import { execSync } from "node:child_process";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { sveltePhosphorOptimize } from "phosphor-svelte/vite";
import { defineConfig, type Plugin } from "vite";

// Short commit hash snapshotted at build time. We display this in
// Settings → Updates → "Current version" instead of the semver from
// tauri.conf.json so every build is individually identifiable during the
// alpha. Falls back to 'unknown' when git isn't available (shallow clone,
// CI without fetch-depth, source tarballs, …).
const commitHash = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
})();

const PR_LENS_CRYPTO_STUB = "\0pr-lens-node-crypto-stub";

// The PR Lens renderer's entry re-exports its manifest module, which pulls in
// `node:crypto` to content-address render assets — a server-only concern we
// never reach, since we render diagrams straight into the DOM. Rollup binds the
// import before it can shake the module out, so the browser build dies on a
// `createHash` that Vite's node shim doesn't provide. Redirect that one import,
// from that one package, to a stub that throws only if it is ever really called.
const prLensNodeCryptoStub = (): Plugin => ({
  name: "pr-lens-node-crypto-stub",
  enforce: "pre",
  resolveId(source, importer) {
    if (source !== "node:crypto" || importer === undefined) return null;
    const fromPrLens =
      importer.includes("@coldtea/pr-lens-renderer") ||
      importer.includes("@coldtea+pr-lens-renderer");
    return fromPrLens ? PR_LENS_CRYPTO_STUB : null;
  },
  load(id) {
    if (id !== PR_LENS_CRYPTO_STUB) return null;
    return 'export const createHash = () => {\n  throw new Error("pr-lens content addressing is unavailable in the browser");\n};\n';
  },
});

export default defineConfig({
  plugins: [tailwindcss(), sveltekit(), sveltePhosphorOptimize(), prLensNodeCryptoStub()],
  envPrefix: ["VITE_", "TAURI_"],
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  worker: {
    format: "es",
  },
  build: {
    // shiki grammars + highlighter bring a few chunks past the default 500 kB
    // threshold; they're already lazy-loaded per language. Bump the warning
    // limit rather than emit noise on every build.
    chunkSizeWarningLimit: 1024,
  },
});
