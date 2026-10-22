---
status: accepted
---

# Support linked clones and user-chosen clone locations

## Context

Until now every tracked repository was a **managed clone**: Revv ran `git clone` into
`~/.revv/repos/{owner}/{name}`, owned that directory outright, and `rm -rf`'d it on removal
(guarded by `assertSafeClonePath`, which refused any path outside the base dir). Worktrees were
created *inside* that directory at `{clonePath}/worktrees/pr-N`, and the PR-ref fetch flow
rewrote the clone's `origin` remote to inject an auth token and created `refs/heads/pr-N`
branches.

We want two new capabilities: let a user **link** a checkout they already have on disk, and let a
**managed** clone land at a **user-chosen base directory** instead of the default.

## Decision

Introduce a single `managed: boolean` (default `true`) on the repository row. It distinguishes a
**managed clone** (Revv created it; Revv owns it) from a **linked clone** (the user's existing
checkout; Revv borrows it). "Custom clone location" is *not* a third kind — it is a managed clone
whose base directory is non-default. `clonePath` stores the resolved working-copy path in both
cases.

Four sub-decisions follow from the managed/linked split:

1. **Worktrees are decoupled from the clone.** They always live at the Revv-owned, per-repo
   location `~/.revv/repos/{owner}/{name}/worktrees/pr-N`, derived from `owner/name`, regardless
   of where the source clone physically lives. (Git still writes worktree admin metadata into the
   source clone's `.git/worktrees/` — unavoidable, and accepted.)

2. **One worktree flow serves both modes**, refactored so it never mutates user-visible repo
   state: PR refs are fetched by an explicit token-authed HTTPS URL (never by rewriting a named
   remote), into `refs/revv/*`, and Revv's working branches live under `refs/heads/revv/*`
   (never un-namespaced `refs/heads/pr-*`). Squatter-removal is scoped to paths
   under `~/.revv/repos` (never force-removes a worktree the user created). Revv always
   authenticates with its own OAuth token; the user's local credentials, SSH keys, and remotes are
   never consulted.

3. **Removal is mode-aware and always confirmed.** A managed clone's directory is `rm -rf`'d on
   removal regardless of location (the `assertSafeClonePath` guard is relaxed from "inside the base
   dir" to "`managed === true`"). A linked clone's directory is **never** a delete target under any
   code path — only the Revv-owned worktree holder is cleaned. The confirmation dialog states which
   case applies.

4. **Linked clones skip the clone lifecycle.** They validate (real git repo + a confirmed
   `owner/name` identity, seeded from the folder's remotes but user-correctable) and jump straight
   to `cloneStatus: "ready"`. A vanished linked directory becomes `cloneStatus: "error"` meaning
   "needs re-link," never an auto-clone trigger. `resumePendingClones` is hard-filtered to
   `managed === true` so a linked row is never re-cloned on boot.

GitHub identity (`owner/name`) remains authoritative for PR sync and is independent of the local
clone's remotes — for linked clones it is *seeded* from `origin` and confirmed, not trusted blind,
which avoids mismapping when `origin` is a fork, mirror, or SSH URL.

## Considered options

- **Two-axis model (origin × location) vs. one boolean.** Rejected the two-axis framing: location
  only matters for managed clones, so a single `managed` flag plus `clonePath` captures all three
  user scenarios without a redundant dimension.
- **De-register custom-location managed clones instead of deleting them.** Rejected: ownership
  should mean ownership. Revv created the directory, so it deletes it — but only behind an explicit,
  mode-aware confirmation. Leaking directories the user can't see is worse than a confirmed delete.
- **Path-first identity inference for linked clones (no confirm).** Rejected: `origin` is
  frequently a fork or non-upstream remote, so inferring the GitHub repo silently would mismap.
  Kept the path-first gesture but added a confirmation/correction step.
- **Fork a linked-only worktree path, leave managed untouched.** Rejected in favour of one shared
  path: lower long-term maintenance and no behavioral divergence between modes.

## Consequences

- The PR-ref fetch no longer rewrites `origin` for *any* repo, including existing managed clones —
  a deliberate behavior change that also removes a long-standing footgun.
- Schema change is additive (`managed` boolean, default `true`); existing rows backfill as managed.
  Lands as a hand-authored migration `.sql` + manual `meta/_journal.json` entry, since
  `drizzle-kit generate` is broken in `apps/server`.
- No in-place mode switch in v1: changing a repo between managed and linked means remove + re-add.
  "Relink in place" is a possible fast-follow.
