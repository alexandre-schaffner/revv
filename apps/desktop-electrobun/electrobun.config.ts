import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Revv Solid Desktop",
    identifier: "dev.revv.solid-desktop",
    version: "0.0.1",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    copy: {
      "dist/index.html": "views/main/index.html",
      "dist/assets": "views/main/assets",
    },
    watchIgnore: ["dist/**"],
  },
} satisfies ElectrobunConfig;
