# Context Glossary

Canonical domain language for Revv. Implementation details belong in code and ADRs, not here.

## Repository working copies

A **repository** tracked in Revv always has a local **working copy** on disk that Revv reads
from to build diffs and run agents. There are two ways that working copy comes to exist:

- **Managed clone** — Revv ran `git clone` to create it. The destination directory is either
  the default (`~/.revv/repos/{owner}/{name}`) or a user-chosen location. Revv **owns** a
  managed clone: it created the directory and may delete it when the repo is removed.
  "Custom clone location" is not a separate kind of repository — it is a managed clone whose
  destination is non-default.

- **Linked clone** — the user pointed Revv at a git checkout they already had on disk. Revv
  **borrows** a linked clone: it never creates and never deletes that directory's lifecycle.

The distinction is captured by a single `managed` boolean on the repository. Everything else
(diff reads, PR sync) treats the two identically.

## Worktrees

A **worktree** is a per-PR checkout Revv creates to materialise a pull request's head commit.
Worktrees always live at a Revv-owned, per-repo location derived from the repo's `owner/name`,
**independent of where the source clone physically lives**:

```
~/.revv/repos/{owner}/{name}/worktrees/pr-{N}
```

For a linked clone, the worktree *checkout* still lives under `~/.revv/repos`, but git stores
the worktree's admin metadata inside the source clone's `.git/worktrees/`.
