import path from "node:path";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  root: "src/views/main",
  base: "./",
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "src/views/main"),
    },
  },
  build: {
    outDir: "../../../dist",
    emptyOutDir: true,
  },
});
