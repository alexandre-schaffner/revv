/**
 * Read `git merge-tree --write-tree --name-only --no-messages -z`: the result
 * tree's OID, then (on exit 1) each conflicted path once, all NUL-terminated.
 */
export type MergeTreeResult =
  | { readonly kind: "clean"; readonly tree: string }
  | { readonly kind: "conflicts"; readonly tree: string; readonly files: readonly string[] }
  | { readonly kind: "failed"; readonly message: string };

export function parseMergeTree(exitCode: number, stdout: string, stderr = ""): MergeTreeResult {
  if (exitCode !== 0 && exitCode !== 1) {
    const line = stderr
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim();
    return { kind: "failed", message: line ?? `git merge-tree exited ${exitCode}` };
  }
  const [tree = "", ...rest] = stdout.split("\0");
  if (!/^[0-9a-f]{40,64}$/.test(tree.trim())) {
    return { kind: "failed", message: "git merge-tree printed no tree" };
  }
  if (exitCode === 0) return { kind: "clean", tree: tree.trim() };
  const files = [...new Set(rest.filter((path) => path.length > 0))];
  return { kind: "conflicts", tree: tree.trim(), files };
}
