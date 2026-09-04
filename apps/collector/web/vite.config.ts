import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
// Inlined (mirrors @revv/shared COLLECTOR_PORT). The Node loader that evaluates
// this config can't resolve the workspace's TS barrel, so we don't import it.
const collector = "http://localhost:45680";

// The dashboard SPA. In dev it runs on its own Vite server (:5174) and proxies
// the API / OTLP / SSE paths to the collector. The production build is emitted
// to web/dist and served statically by the collector itself on COLLECTOR_PORT.
export default defineConfig({
  root,
  plugins: [tailwindcss(), svelte()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": collector,
      "/v1": collector,
      "/events": { target: collector, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
