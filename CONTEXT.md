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

## GitHub authentication

**Classic OAuth App**:
A GitHub integration that authenticates a user and receives a user token carrying coarse, account-wide scopes. The narrowest scope granting private-repo access is `repo` — full read/write to all code the user can reach; it cannot be narrowed.
_Avoid_: "OAuth", "the GitHub login" (ambiguous between this and a GitHub App's user-to-server flow)

**GitHub App**:
A GitHub integration with fine-grained, per-resource permissions (e.g. Pull requests: read & write, Contents: read) that an org or account owner installs onto specific repositories. The unit org admins approve and scope.

**Installation token**:
A short-lived token minted for a GitHub App's installation. Acts as the **app/bot**, not a human — anything it writes (e.g. a review comment) is attributed to the app.

**User-to-server token**:
A token a GitHub App obtains by authenticating a user (device flow works). Acts **as the user**, limited to the intersection of what the user can access and where the app is installed. Preserves human attribution on review comments — the property a code-review tool needs.
