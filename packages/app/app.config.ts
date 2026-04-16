import { defineConfig } from "@tanstack/react-start/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  vite: {
    plugins: [
      tsconfigPaths({
        projects: ["./tsconfig.json"],
      }),
    ],
  },
});
