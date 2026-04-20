import { Type } from "@sinclair/typebox";
import { cmd } from "../../lib/cmd";

export const listGitRepos = cmd(
  "sh",
  Type.Array(Type.String()),
  {
    args: () => {
      const dirs = [
        "dev",
        "Developer",
        "projects",
        "src",
        "code",
        "repos",
        "workspace",
      ]
        .map((d) => `~/${d}`)
        .join(" ");
      return [
        "-c",
        `for d in ${dirs}; do [ -d "$d" ] && find "$d" -maxdepth 2 -name .git -type d 2>/dev/null; done`,
      ];
    },
    parse: (stdout: string) =>
      [...new Set(
        stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((p) => p.replace(/\/\.git$/, "")),
      )].sort(),
    staleTime: 60_000,
  },
);
