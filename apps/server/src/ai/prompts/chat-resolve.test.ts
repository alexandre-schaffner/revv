import { describe, expect, it } from "bun:test";
import { buildResolveConflictsPrompt, buildResolveConflictsUserMessage } from "./chat";

describe("buildResolveConflictsPrompt", () => {
  it("names both branches and every conflict file in the push-merge prompt", () => {
    const prompt = buildResolveConflictsPrompt(
      { kind: "push-merge", agentBranch: "revv/pr-4", sourceBranch: "feat" },
      ["a.ts", "b.ts"],
    );
    expect(prompt).toContain("`revv/pr-4`");
    expect(prompt).toContain("`feat`");
    expect(prompt).toContain("- `a.ts`\n- `b.ts`");
    expect(prompt).not.toContain("{{");
  });

  it("names both branches in the base-merge prompt", () => {
    const prompt = buildResolveConflictsPrompt(
      { kind: "base-merge", baseBranch: "main", sourceBranch: "feat" },
      ["a.ts", "b.ts"],
    );
    expect(prompt).toContain("the latest `main`");
    expect(prompt).toContain("`feat`");
    expect(prompt).toContain("- `a.ts`\n- `b.ts`");
    expect(prompt).toContain("merge --continue");
    expect(prompt).not.toContain("{{");
  });

  it("drives the rebase forward and never past a commit", () => {
    const task = { kind: "base-rebase", baseBranch: "main", sourceBranch: "feat" } as const;
    const prompt = buildResolveConflictsPrompt(task, []);
    expect(prompt).toContain("rebase --continue");
    expect(prompt).toContain("**Do NOT** run `git rebase --abort`, `git rebase --skip`");
    expect(prompt).not.toContain("merge --continue");
    expect(prompt).not.toContain("{{");
    expect(buildResolveConflictsUserMessage(task)).toContain("rebase");
  });
});
