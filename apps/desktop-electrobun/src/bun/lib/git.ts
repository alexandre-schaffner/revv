export async function runGitCommand(
  cwd: string,
  args: string[],
): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = (await new Response(proc.stdout).text()).trim();
  const err = (await new Response(proc.stderr).text()).trim();
  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${err}`);
  }
  return output;
}

export async function getGitBranch(path: string): Promise<string | null> {
  try {
    const branch = await runGitCommand(path, ["branch", "--show-current"]);
    return branch || null;
  } catch {
    return null;
  }
}

export async function getWorktreeCount(path: string): Promise<number> {
  try {
    const output = await runGitCommand(path, ["worktree", "list"]);
    // First line is a header, so subtract 1
    const lines = output.split("\n").filter((line) => line.trim());
    return Math.max(0, lines.length - 1);
  } catch {
    return 0;
  }
}
