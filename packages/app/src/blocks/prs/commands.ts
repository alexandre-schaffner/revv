import { createServerFn } from "@tanstack/react-start";
import { run } from "../../lib/command-log";
import type { CommandEntry } from "../../lib/command-log";

const BLOCK = "prs";

/** Run `gh pr list` for the current repo. Returns the completed command. */
export const requestPrList = createServerFn({ method: "POST" }).handler(
  async (): Promise<CommandEntry> => {
    return run(BLOCK, "gh", [
      "pr",
      "list",
      "--json",
      "number,title,author,state,headRefName,updatedAt",
    ]);
  },
);

export interface PrDetail {
  body: string;
  url: string;
  title: string;
  state: string;
  author: string;
  branch: string;
  files: string[];
}

/** Split a multi-file unified diff into an array of single-file diffs. */
function splitDiffByFile(diff: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }
  return chunks;
}

/** Fetch full PR detail via `gh pr view`. */
export const fetchPrDetail = createServerFn({ method: "POST" })
  .inputValidator((input: { number: number }) => input)
  .handler(async ({ data }): Promise<PrDetail> => {
    const meta = await run(BLOCK, "gh", [
      "pr", "view", String(data.number),
      "--json", "title,state,author,headRefName,url,body",
    ]);

    if (meta.status !== "done" || !meta.result) {
      throw new Error(`gh pr view failed: ${meta.result?.stderr ?? "unknown error"}`);
    }

    const pr = JSON.parse(meta.result.stdout) as {
      title: string;
      state: string;
      author: { login: string };
      headRefName: string;
      url: string;
      body: string;
    };

    const diffEntry = await run(BLOCK, "gh", [
      "pr", "diff", String(data.number),
    ]);

    const diffStdout = diffEntry.result?.stdout ?? "";
    const files = diffEntry.status === "done" && diffStdout.trim().length > 0
      ? splitDiffByFile(diffStdout)
      : [];

    return {
      body: pr.body ?? "",
      url: pr.url,
      title: pr.title,
      state: pr.state,
      author: pr.author.login,
      branch: pr.headRefName,
      files,
    };
  });
