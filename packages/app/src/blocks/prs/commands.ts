import { createServerFn } from "@tanstack/react-start";
import { enqueue } from "../../lib/command-log";
import type { CommandEntry } from "../../lib/command-log";

const BLOCK = "prs";

/** Enqueue `gh pr list` for the current repo. Returns the pending command. */
export const requestPrList = createServerFn({ method: "POST" }).handler(
  async (): Promise<CommandEntry> => {
    return enqueue(BLOCK, "gh", [
      "pr",
      "list",
      "--json",
      "number,title,author,state,headRefName,updatedAt",
    ]);
  },
);
