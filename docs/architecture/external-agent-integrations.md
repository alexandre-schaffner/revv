# External coding-agent integrations

Revv exposes the active PR's walkthrough, issues, and review conversations to
coding agents that run outside its own agent lifecycle: **Claude Code**,
**Codex**, **OpenCode**, and **Cursor**. All four share one credential model,
one stdio bridge, one MCP route, and one tool bundle. Only the install
mechanics differ, because each agent reads a different config file.

## Caller usage

1. A signed-in Revv user opens **Settings → Integrations** and connects a
   provider. Revv installs or refreshes that agent's client configuration and
   rotates its account credential.
2. The agent starts the stdio MCP bridge in the current project. The bridge
   derives the repository identity and recent commit ancestry from the
   checkout, then proxies MCP JSON-RPC to Revv's loopback server.
3. Revv authenticates the credential, resolves the repository and PR inside
   the credential's GitHub account, and exposes only the integration tool
   surface for that PR.
4. The agent calls `get_review_context`, edits and verifies the checkout, and
   may then record an issue resolution, update supported walkthrough content,
   reply to a review thread, or change a thread's status.
5. Revv commits each mutation to SQLite before broadcasting it. GitHub thread
   pushes happen after the local commit and are retryable.

## Per-provider install targets

| Provider    | MCP configuration                       | Workflow prompt                                     |
| ----------- | --------------------------------------- | --------------------------------------------------- |
| Claude Code | `~/.claude/skills/revv/.mcp.json`       | `~/.claude/skills/revv/skills/address-feedback/`     |
| Codex       | `~/.codex/config.toml` (managed block)  | `~/.codex/prompts/revv-address-feedback.md`          |
| OpenCode    | `~/.config/opencode/opencode.json`      | `~/.config/opencode/command/revv-address-feedback.md`|
| Cursor      | `~/.cursor/mcp.json`                    | — (Cursor has no global prompt directory)           |

Claude Code loads `~/.claude/skills/<dir>` containing a plugin manifest as a
user-scoped plugin, which is what gives its MCP server the stable
`plugin:revv:review` name. The other three launch the bridge from a private
copy under `~/.revv/<provider>/server/revv-mcp.ts`.

Every install is **convergent** and **non-destructive**: reconnecting
reproduces the same end state with a rotated credential, and Revv refuses to
overwrite or delete a directory, config section, or prompt file it did not
create. Directory installs are staged and swapped under a `.revv-managed`
marker; Codex's `config.toml` uses a `# >>> revv managed >>>` fenced block;
the JSON configs get a single `revv` key that is recognized by the
`REVV_INTEGRATION_TOKEN` in its environment.

## Type sketch

```ts
type ExternalAgentProvider = "claude-code" | "codex" | "opencode" | "cursor"

type ExternalAgentScope =
  | "context:read"
  | "walkthrough:edit"
  | "issues:resolve"
  | "comments:write"

interface ExternalProjectIdentity {
  repositoryFullName: string
  headCandidates: readonly string[]
  branch: string | null
}

interface ExternalResolvedContext {
  provider: ExternalAgentProvider
  integrationId: string
  accountId: string
  userId: string
  prId: string
  scopes: readonly ExternalAgentScope[]
}

interface ExternalIntegrationsService {
  status(accountId: string): Effect<readonly ExternalIntegrationStatus[], IntegrationError>
  connect(input: {
    accountId: string
    userId: string
    provider: ExternalAgentProvider
  }): Effect<ConnectResult, IntegrationError>
  disconnect(accountId: string, provider: ExternalAgentProvider): Effect<void, IntegrationError>
  resolve(
    token: string,
    project: ExternalProjectIdentity,
  ): Effect<ExternalResolvedContext, IntegrationError>
}
```

Each credential is stored in SQLite only as a SHA-256 digest, one row per
`(provider, account)`. The installed client configuration gets the plaintext
value. Reconnecting rotates the credential and atomically replaces Revv-owned
files. The token prefix (`revv_cc`, `revv_cx`, `revv_oc`, `revv_cu`) makes a
leaked value traceable to its provider without a database lookup.

Issue resolution is durable metadata on `walkthrough_issues`:

```ts
type IssueResolutionStatus = "open" | "addressed" | "wont_fix"

interface IssueResolution {
  status: IssueResolutionStatus
  explanation?: string
  evidence: readonly string[]
  resolvingCommitSha?: string
  resolvedAt?: string
  resolvedBy?: ExternalAgentProvider
}
```

Repeated resolution calls with the same canonical payload are no-ops and keep
the original timestamp. Replies require an explicit idempotency key and derive
their message ID from `(integrationId, threadId, idempotencyKey)` — so the
same key retried from the same integration never duplicates a local reply,
regardless of which provider issued it.

## Module map

- `packages/shared/src/external-integrations.ts` is the source of truth for
  provider identity and display names.
- `apps/server/src/services/ExternalIntegrations.ts` owns credential
  lifecycle and project-to-PR resolution for every provider.
- `apps/server/src/services/external-integrations/install.ts` owns the
  per-provider filesystem mechanics behind one `externalIntegrationInstaller`
  registry.
- `integrations/external-mcp-bridge/revv-mcp.ts` is the single stdio bridge
  every provider installs; `integrations/external-agent-guides/` holds the
  single workflow guide every provider's prompt is rendered from;
  `integrations/claude-code-plugin/` holds only what is Claude-specific.
- `apps/server/src/ai/providers/external-review-tools.ts` owns the smaller
  external MCP tool bundle and its idempotent issue/comment handlers.
- `apps/server/src/routes/mcp/external-agent.ts` binds authenticated project
  context to the shared tool gateway at `POST /mcp/external`.
- `apps/server/src/routes/integrations.ts` exposes signed-in status, connect,
  and disconnect operations to the desktop UI.
- `walkthrough_issues` stores local resolution metadata; `external_integrations`
  stores durable credential digests and scopes.

## Boundaries and invariants

- Bridge input, bearer credentials, repository names, commit SHAs, MCP
  payloads, and tool arguments are validated at their entry boundaries.
- The server never accepts a PR id from the bridge. It derives the PR from the
  credential's account plus a tracked repository and commit ancestry.
- GitHub-submitted walkthrough issues remain immutable. External agents
  resolve their linked comment threads instead.
- Existing chat-edit handlers remain the single implementation of walkthrough
  content edits. The external bundle selects safe specs from that registry.
- Every write is attributed to the calling provider: `resolvedBy`,
  `walkthroughs.lastEditedBy`, and the reply author name all carry it.
- The stdio bridge is stateless. SQLite is authoritative for connection,
  review, resolution, and comment state.
- **The bridge answers every request that carries an `id`, always.** An error
  status with an empty body (what an unmatched route returns) still becomes a
  JSON-RPC error, and a wedged server times out. A dropped response is
  indistinguishable from a hang on the agent side, with no diagnostic.

## Alternatives considered

1. Register Revv's existing `/mcp/chat-context` endpoint directly. Rejected:
   its tokens are intentionally per-turn and its tool surface is too broad.
2. A remote/HTTP MCP entry per provider. Rejected: HTTP servers do not receive
   the active project directory, so PR resolution becomes manual.
3. One bridge process per provider with provider-specific logic. Rejected:
   agent-path parity (CLAUDE.md #13) is easiest to guarantee when there is
   literally one bridge, one route, and one tool bundle.
4. Let the bridge mutate SQLite or GitHub directly. Rejected: it would bypass
   Revv's lifecycle, authorization, broadcast, and sync ownership.

## Synthesis decision

One credential model, one stdio proxy, and one authenticated Revv MCP route,
with per-provider install mechanics isolated behind a small registry. Share
existing walkthrough handlers, add only the missing issue-resolution and
thread workflows, and keep the external tool list capability-filtered. This is
the smallest shape that works across ordinary clones and worktrees, on four
agents, without weakening Revv's agent invariants.
