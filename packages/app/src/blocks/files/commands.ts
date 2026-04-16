import { createServerFn } from "@tanstack/react-start";
import { enqueue } from "../../lib/command-log";
import type { CommandEntry } from "../../lib/command-log";

const BLOCK = "files";

/** Enqueue an `ls -la` for the current cwd. Returns the pending command. */
export const requestLs = createServerFn({ method: "POST" }).handler(
  async (): Promise<CommandEntry> => {
    return enqueue(BLOCK, "ls", ["-la"]);
  },
);
