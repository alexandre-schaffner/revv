import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Rev",
    identifier: "com.rev.desktop",
    version: "0.0.1",
  },
  build: {
    bun: {
      entrypoint: "./src/bun/index.ts",
    },
    views: {
      mainview: {
        entrypoint: "./src/view/index.ts",
      },
    },
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
} satisfies ElectrobunConfig;
