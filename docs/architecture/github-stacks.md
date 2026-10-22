# GitHub PR stacks

How Revv reviews a PR that sits in one of GitHub's native stacks, and what it owns: navigating the stack, reviewing it, and noticing when it moves.

## Sources of truth

| What | Owner | Where |
|---|---|---|
| Membership (stack number, position) | GitHub, mirrored by the poll | `pull_requests.stack_number/stack_position`, `services/github-graphql-prs.ts` |
| Stack detail (every layer's state, merge settings) | GitHub | `services/stacks/queries.ts` `PR_STACK_QUERY`, cached 30s in kv `pr-stack` |
| Per-layer review state, restack verdict | Revv's DB, recomputed per read | `services/stacks/overlay.ts` |
| What a walkthrough's agent saw | the walkthrough row | `walkthroughs.stack_context`, `diff_fingerprint` |
| Whole-stack brief | the stack-brief pipeline | `stack_briefs`, `stack_brief_layers` |

Never infer a stack from branch chains. A merged bottom layer gets retargeted and drops out of any branch walk. Hosts that predate stacks reject the fields: the poll lists them without stacks (`stacklessUntil`), and `StackService` answers "not stacked", so every stack surface hides.

## Freshness

`StackService.detail` serves the GitHub half from the kv cache for 30s, then re-reads GitHub, and falls back to the cached copy (`stale: true`) when GitHub is unreachable. The Revv half is read from the DB on every call. Clients re-read on:

- `stack:updated`: the poll saw a member join, leave, move, or change head or base, or a stacked PR close. The server drops the cache first.
- a member's `walkthrough:event` lifecycle envelope
- `stack-brief:status-changed`

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
| `needs-rebase` | A layer below merged and this one still targets it or conflicts. | Banner. |
