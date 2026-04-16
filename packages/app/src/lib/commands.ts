import { createServerFn } from "@tanstack/react-start";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

export const getCwd = createServerFn({ method: "GET" }).handler(async () => {
  return process.cwd();
});

export const setCwd = createServerFn({ method: "POST" })
  .inputValidator((input: { path: string }) => input)
  .handler(async ({ data }) => {
    process.chdir(data.path);
    return process.cwd();
  });

export const getGitRepos = createServerFn({ method: "GET" }).handler(
  async () => {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const searchDirs = [
      join(home, "dev"),
      join(home, "Developer"),
      join(home, "projects"),
      join(home, "src"),
      join(home, "code"),
      join(home, "repos"),
      join(home, "workspace"),
    ];

    const repos: string[] = [];

    for (const dir of searchDirs) {
      if (!existsSync(dir)) continue;
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const fullPath = join(dir, entry.name);
          if (existsSync(join(fullPath, ".git"))) {
            repos.push(fullPath);
          }
        }
      } catch {
        // skip inaccessible dirs
      }
    }

    try {
      const cwd = process.cwd();
      if (existsSync(join(cwd, ".git")) && !repos.includes(cwd)) {
        repos.unshift(cwd);
      }
    } catch {
      // ignore
    }

    return repos.sort();
  },
);
