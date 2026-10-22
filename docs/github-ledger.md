# GitHub call ledger

Every HTTP request the server sends to GitHub (REST, GraphQL, OAuth, avatars,
log downloads) is recorded with the route or loop that caused it, then
analyzed for what made data load slowly or burned rate budget for nothing.

## Using it

The ledger is on for the dev channel (`make dev`, `make dev-server`). Use the
app, then:

```bash
bun run github:audit                      # everything recorded so far
bun run github:audit --since 2m           # the last two minutes
bun run github:audit --origin conversation --timeline
bun run github:audit --json               # the raw report
```

The file is `apps/server/github-ledger.dev.jsonl` (rotated at 50 MB to
`.jsonl.1`). A running server hands out the calls still in its in-memory ring,
unanalyzed, at `GET /api/_debug/github?since=2m&origin=api` (`REVV_DEBUG=1` or
a dev build), and `POST /api/_debug/github/clear` empties that ring.

To profile a single page load: `--since 30s --origin api --timeline` right
after opening it shows each GitHub call as a bar on one time axis, labelled by
the Revv route that waited on it.

`REVV_GITHUB_LEDGER` overrides the default: `0` off, `1` on beside the DB
(prod too), or a path for the JSONL.

## What it reports

Findings, ranked by estimated waiting caused (background work counts a
quarter: it competes for the same budget and connections, but nobody is
staring at it). The estimates order the list; they are upper bounds, not
promises.

| Finding | What it means |
| --- | --- |
| `duplicate-inflight` | An identical read sent while the first was still in flight. |
| `duplicate-repeat` | An identical read repeated within 30s. A 304 is free on the REST budget but still a round trip. |
| `waterfall` | A run's reads waited on each other (pages collapsed); the gap to its longest read is what parallelism could win. |
| `serial-pagination` | Many pages of one read. REST pages can run concurrently; GraphQL cursors can't, so read less. |
| `fan-out` | One endpoint asked about many things in one run: batch it. |
| `slow-op` | A user-facing operation slow at p95 (1s). |
| `failing-op` | Errors: HTTP, network, or GraphQL `errors` in a 200. |
| `heavy-op` | Answers over 256 KB on average. |
| `contention` | User-facing calls that started behind 3+ background calls, and how much slower they were. |
| `unattributed` | Calls with no origin, with their call sites. |

Then tables by origin and by operation, and the rate budget burned per token.
The budget numbers are `x-ratelimit-used` deltas, and the budget is per token:
another client on the same token (the installed Revv, `gh`, an IDE) lands in
them too. REST deltas past one point per call are split out as "other
clients"; GraphQL costs vary per query, so its deltas can't be.

## How attribution works

`apps/server/src/observability/github-ledger/`:

- `record.ts` wraps `globalThis.fetch`, so no call site can slip past. Besides
  github.com, it records the Enterprise hosts named in `GITHUB_HOST`,
  `user_settings` and `repositories`.
- `origin.ts` carries the origin, one carrier per world. In promise code it is
  `AsyncLocalStorage`: the request hook in `index.ts` enters one with
  `enterOrigin`. Inside Effect it is the Effect Context only, because a fiber
  woken by another fiber resumes in the waker's ALS context. `AppRuntime`
  copies the caller's ALS origin into the Context once, at entry. A loop names
  its own runs with `withGitHubOrigin("poll:...")`. `githubTryPromise` (used
  for every GitHub call in `github-rest.ts` and `GitHub.ts`) hands the fiber's
  origin to the promise; with none, the call is `unattributed`.
- `analyze.ts` is pure: records in, report out.

A new background loop that calls GitHub should wrap each iteration in
`withGitHubOrigin`; until it does, its calls show up under whatever started
it, or as `unattributed`.
