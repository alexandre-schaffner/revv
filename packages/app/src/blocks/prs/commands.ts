import { Type, type Static } from "@sinclair/typebox";
import { cmd } from "../../lib/cmd";

// ── Schemas ──────────────────────────────────────────────

const PrEntry = Type.Object({
  number: Type.Number(),
  title: Type.String(),
  author: Type.Object({
    login: Type.String(),
    avatarUrl: Type.Optional(Type.String()),
  }),
  state: Type.String(),
  headRefName: Type.String(),
  updatedAt: Type.String(),
});

export type PrEntry = Static<typeof PrEntry>;

const PrDetail = Type.Object({
  title: Type.String(),
  state: Type.String(),
  author: Type.Object({ login: Type.String() }),
  headRefName: Type.String(),
  url: Type.String(),
  body: Type.String(),
});

export type PrDetail = Static<typeof PrDetail>;

// ── Commands ─────────────────────────────────────────────

export const listPrs = cmd(
  "gh pr list --json number,title,author,state,headRefName,updatedAt",
  Type.Array(PrEntry),
  { staleTime: 10_000, refetchInterval: 30_000, cwd: "worktree" },
);

export const viewPr = cmd("gh pr view", PrDetail, {
  args: ({ number }: { number: number }) => [
    String(number),
    "--json",
    "title,state,author,headRefName,url,body",
  ],
  staleTime: 30_000,
});

/**
 * Fetch PR diff as an array of per-file patches.
 * `gh pr diff` outputs raw unified diff, we split by file.
 */
export const getPrDiff = cmd("gh pr diff", Type.Array(Type.String()), {
  args: ({ number }: { number: number }) => [String(number)],
  parse: (stdout: string) => {
    if (!stdout.trim()) return [];
    const chunks: string[] = [];
    let current: string[] = [];
    for (const line of stdout.split("\n")) {
      if (line.startsWith("diff --git ") && current.length > 0) {
        chunks.push(current.join("\n"));
        current = [];
      }
      current.push(line);
    }
    if (current.length > 0) chunks.push(current.join("\n"));
    return chunks;
  },
  staleTime: 30_000,
  cwd: "worktree",
});
