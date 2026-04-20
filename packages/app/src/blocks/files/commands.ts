import { Type } from "@sinclair/typebox";
import { cmd } from "../../lib/cmd";

const FileEntry = Type.Object({
  permissions: Type.String(),
  name: Type.String(),
  isDir: Type.Boolean(),
});

function parseLsOutput(stdout: string): unknown {
  return stdout
    .split("\n")
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 9) return null;
      const permissions = parts[0]!;
      if (
        !permissions.startsWith("d") &&
        !permissions.startsWith("-") &&
        !permissions.startsWith("l")
      )
        return null;
      const name = parts.slice(8).join(" ");
      if (name === "." || name === "..") return null;
      return { permissions, name, isDir: permissions.startsWith("d") };
    })
    .filter(Boolean);
}

export type { Static as FileEntryType } from "@sinclair/typebox";

export const listFiles = cmd("ls -la", Type.Array(FileEntry), {
  parse: parseLsOutput,
  cwd: "worktree",
  staleTime: 5_000,
});
