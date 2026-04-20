import { createServerFn } from "@tanstack/react-start";
import { run } from "../../lib/command-log";
import type { CommandEntry } from "../../lib/command-log";

const BLOCK = "files";

/** Run `ls -la` for the current cwd. Returns the completed command. */
export const requestLs = createServerFn({ method: "POST" }).handler(
  async (): Promise<CommandEntry> => {
    return run(BLOCK, "ls", ["-la"]);
  },
);
