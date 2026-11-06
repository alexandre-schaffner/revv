export interface NameStatusEntry {
  readonly status: string;
  readonly filename: string;
  readonly previousFilename: string | null;
}

/**
 * Parse `git diff --name-status -z` output. The `-z` form is NUL-separated and
 * emits the pre-image path before the post-image path for renames/copies.
 */
export function parseNameStatusZ(raw: string): ReadonlyArray<NameStatusEntry> {
  const tokens = raw.split("\0").filter((token) => token.length > 0);
  const files: NameStatusEntry[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousFilename = tokens[i++];
      const filename = tokens[i++];
      if (previousFilename && filename) {
        files.push({ status, filename, previousFilename });
      }
      continue;
    }
    const filename = tokens[i++];
    if (filename) {
      files.push({ status, filename, previousFilename: null });
    }
  }
  return files;
}

export interface LineCounts {
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Parse `git diff --numstat` into per-path counts. Keyed by the raw numstat
 * path: for non-renamed files that equals the name-status filename (an exact
 * hit, no patch-body scan needed); renamed files use `a => b` notation and
 * simply miss, falling back to `countPatchLines`. Binary files report `-` for
 * both columns → treated as 0/0.
 */
export function parseNumstat(raw: string): ReadonlyMap<string, LineCounts> {
  const counts = new Map<string, LineCounts>();
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const firstTab = line.indexOf("\t");
    if (firstTab < 0) continue;
    const secondTab = line.indexOf("\t", firstTab + 1);
    if (secondTab < 0) continue;
    const addRaw = line.slice(0, firstTab);
    const delRaw = line.slice(firstTab + 1, secondTab);
    const path = line.slice(secondTab + 1);
    const additions = addRaw === "-" ? 0 : Number.parseInt(addRaw, 10);
    const deletions = delRaw === "-" ? 0 : Number.parseInt(delRaw, 10);
    if (Number.isNaN(additions) || Number.isNaN(deletions)) continue;
    counts.set(path, { additions, deletions });
  }
  return counts;
}

export interface WorktreeEntry {
  readonly path: string;
  /** `refs/heads/<name>`, or null when detached. */
  readonly branch: string | null;
  /** Git would prune it: its directory is gone. */
  readonly prunable: boolean;
}

/** Parse `git worktree list --porcelain`: one blank-line-separated record per worktree. */
export function parseWorktreeList(raw: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of raw.split("\n\n")) {
    let path: string | null = null;
    let branch: string | null = null;
    let prunable = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).trim();
      else if (line.startsWith("prunable")) prunable = true;
    }
    if (path) entries.push({ path, branch, prunable });
  }
  return entries;
}
