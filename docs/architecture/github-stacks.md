# GitHub PR stacks

How Revv reviews a PR that sits in one of GitHub's native stacks, and what it owns: navigating the stack, reviewing it, merging it, and noticing when it moves.

## Sources of truth

| What | Owner | Where |
|---|---|---|
| Membership (stack number, position) | GitHub, mirrored by the poll | `pull_requests.stack_number/stack_position`, `services/github-graphql-prs.ts` |
| Stack detail (every layer's state, merge settings) | GitHub | `services/stacks/queries.ts` `PR_STACK_QUERY`, cached 30s in kv `pr-stack` |
| Per-layer review state, restack verdict | Revv's DB, recomputed per read | `services/stacks/overlay.ts` |
| What a walkthrough's agent saw | the walkthrough row | `walkthroughs.stack_context`, `diff_fingerprint` |
| Whole-stack brief | the stack-brief pipeline | `stack_briefs`, `stack_brief_layers` |
| A merge in progress | `stack_merge_runs`, advanced against GitHub | `services/stacks/StackMerge.ts` |

Never infer a stack from branch chains. A merged bottom layer gets retargeted and drops out of any branch walk. Hosts that predate stacks reject the fields: the poll lists them without stacks (`stacklessUntil`), and `StackService` answers "not stacked", so every stack surface hides.

GitHub's GraphQL has no stack mutations. Everything Revv does to a stack through the API is a per-PR call: merge, `enablePullRequestAutoMerge`, PATCH base. A rebase is git (see "Rebasing a stack"). GitHub does have a REST stacks API (`/repos/{o}/{r}/stacks`: list, create, add, unstack) and an async merge endpoint (`PUT /pulls/{n}/merge-async`) that its docs call the only way to merge a stacked PR; Revv doesn't use either yet.

## Freshness

`StackService.detail` serves the GitHub half from the kv cache for 30s, then re-reads GitHub, and falls back to the cached copy (`stale: true`) when GitHub is unreachable. The Revv half is read from the DB on every call. Clients re-read on:

- `stack:updated`: the poll saw a member join, leave, move, or change head or base, or a stacked PR close. The server drops the cache first.
- a member's `walkthrough:event` lifecycle envelope
- `stack-brief:status-changed`, `stack-merge:progress`

## Walkthroughs

A stacked PR's `/pulls/:n/files` is three-dot against the layer below, so the agent already reads only the layer's own changes. At job start the orchestrator records:

- `stack_context`: a `WalkthroughStackSnapshot`. A resume prompts with the same stack, and a later read compares it to the live stack.
- `diff_fingerprint`: per-file hash of status and patch, hunk headers included.

The prompt gains a `### Stack` block, and the agent can call `get_stack_context` (a DB-only read tool). That returns lower layers' takeaways and open issues, and upper layers' titles and file lists, so the agent never flags an absence a higher layer fills.

**Restack verdicts** (`overlay.ts restackVerdict`):

| Verdict | Meaning | What Revv does |
|---|---|---|
| `current` | Nothing has moved. | Nothing. |
| `below-moved` | The review still reads true; the context around it moved. | Banner. |
| `restacked` | New head, byte-identical layer changes. | Carries the review over: a new row at the new head, hydrated from the prior row through `WalkthroughSnapshotImporter`, with no agent run. |
| `layer-changed` | The layer's own changes differ. | Incremental run over only the changed files' current patches (`diffSource: stack_layer_delta`), never `git diff oldHead newHead`, which drags in lower-layer churn. |
| `needs-rebase` | A layer below merged and this one still targets it or conflicts. | Banner with **Rebase stack**. |

## Rebasing a stack

GitHub's merge box offers **Rebase stack** once a stack loses its linear history: a lower layer got new commits, or the base moved ahead. Its server-side rebase has no API, so Revv runs the same cascade `gh stack rebase` does, in the repo's clone:

1. `planStackRebase` (`rebase-plan.ts`): every open layer, bottom-up, goes onto the open layer below it, the lowest onto the stack base's tip. A layer's own commits start at the head the layer below had before the rebase, so a squash-merged layer's commits stay out of the layer above (`rebase --onto`, not a plain rebase). With no such ancestor, the merge base. Refuses a closed layer with open layers on it and a layer in the merge queue.
2. `replayStack` (`stack-rebase-git.ts`): fetch the base and every head, then rebase each layer in one scratch worktree on a detached HEAD (`worktrees/stack-N-rebase`). The clone shares refs with other worktrees, so nothing names a local branch and `rebase.updateRefs` is forced off. Commits use the user's own git config (identity, signing). A shallow clone missing a merge base is deepened once.
3. `pushStack`: one `push --atomic` with a `--force-with-lease` per moved branch. Either every layer moves or none does, and a branch that moved meanwhile is never overwritten.
4. Retarget the lowest open layer onto the stack base when the layer below merged and GitHub left it pointing at the merged branch.

A conflict stops the cascade before anything is pushed and names the layer and files. Nothing is journaled: the remote only ever sees the one atomic push, and the next rebase clears a scratch worktree a crash left behind. One rebase per stack at a time, and none while a merge of the stack is running (the run rebases on its own, below). `StackRebaseService.rebase` also refuses when an open layer moved since the user looked (`expectedHeads`).

Whether a layer is behind its base comes from `Ref.compare` (`behindBy`), asked for every open layer in one aliased query beside the stack read. `mergeStateStatus` says BEHIND only under strict branch protection, and `viewerCanUpdateBranch` is false on stacked PRs.

## Merging a stack

The user confirms "merge through layer N". A persisted run steps bottom-up. Each step re-reads GitHub, so it is idempotent:

1. Wait for GitHub to retarget the layer onto the stack base, then PATCH base if it didn't.
2. Wait out `UNKNOWN`.
3. On `DIRTY`/`BEHIND`, or a layer behind its base, rebase the stack once (`StackRebaseService.rebaseStack`) and merge the rebased head. The run made those heads from the ones the user confirmed, so it pins the merge to them (`rebasedFrom` keeps the old head, which a lagging read may still show). A second time, or a conflict, stops the run.
4. Merge, pinned with `sha` to the head the user saw.

When the repo allows auto-merge, a layer already on the stack base that is only waiting on checks is handed to `enablePullRequestAutoMerge(expectedHeadOid)`. A run still active at boot is marked `expired` with a Continue action, never resumed silently.

### Open questions (spike S0, needs a real native stack)

Stacks can't be created through the API, so these have to be observed by hand on a throwaway 3-layer stack. Each answer may let a defensive step in `StackMerge.ts` go:

1. After layer 1 merges (merge commit, squash, rebase), does GitHub retarget layer 2 onto the stack base by itself? How fast? Does it depend on the head branch being auto-deleted?
2. Does GitHub refuse to merge layer 2 while layer 1 is open, or would it merge layer 2 into layer 1's branch? (Revv never offers the latter: the merge pill becomes "Merge through #N…".)
3. Does auto-merge enabled on layer 2 fire before layer 1 lands?
4. Does PATCHing layer 2's base keep it in the stack (`RETARGET_BY_PATCH`)?
5. After a squash merge of layer 1, what do layer 2's `mergeStateStatus` and diff look like until the author restacks?
6. What does `stack.entries` report for merged layers, and for how long?
