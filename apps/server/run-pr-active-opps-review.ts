#!/usr/bin/env bun
/**
 * Walkthrough pipeline for the "feat: user rewards active opps" PR.
 * Creates a new walkthrough row and executes the full A→B→C→D pipeline.
 *
 * Usage: bun run run-pr-active-opps-review.ts
 */

import { and, eq } from "drizzle-orm";
import { createDb } from "./src/db";
import { walkthroughs } from "./src/db/schema/walkthroughs";
import { repositories } from "./src/db/schema/repositories";
import { pullRequests } from "./src/db/schema/pull-requests";
import { reviewSessions } from "./src/db/schema/review-sessions";
import {
	getWalkthroughStateHandler,
	setOverviewHandler,
	addSemanticStepHandler,
	addDiffStepHandler,
	flagIssueHandler,
	addIssueCommentHandler,
	setSentimentHandler,
	rateAxisHandler,
	completeWalkthroughHandler,
} from "./src/ai/providers/walkthrough-tools";
import type { WalkthroughToolContext } from "./src/ai/providers/walkthrough-tool-spec";
import type { WalkthroughStreamEvent, WsServerMessage } from "@revv/shared";

// ── Config ───────────────────────────────────────────────────────────────────

const DB_PATH = "./revv.db";
const REPO_ID = "seed-repo-active-opps-001";
const PULL_REQUEST_ID = "seed-pr-active-opps-001";
const REVIEW_SESSION_ID = "seed-session-active-opps-001";
const PR_HEAD_SHA = "active-opps-pr-sha-001";
const WALKTHROUGH_ID = crypto.randomUUID();

// ── Setup ────────────────────────────────────────────────────────────────────

console.log(`\n=== "feat: user rewards active opps" Walkthrough Pipeline ===`);
console.log(`Walkthrough ID: ${WALKTHROUGH_ID}`);
console.log(`DB: ${DB_PATH}\n`);

const db = createDb(DB_PATH);
const now = new Date().toISOString();

// ── Seed hierarchy (idempotent) ───────────────────────────────────────────────
db.insert(repositories)
	.values({
		id: REPO_ID,
		provider: "github",
		owner: "angle-protocol",
		name: "merkl-api",
		fullName: "angle-protocol/merkl-api",
		defaultBranch: "main",
		addedAt: now,
		cloneStatus: "pending",
	})
	.onConflictDoNothing()
	.run();

db.insert(pullRequests)
	.values({
		id: PULL_REQUEST_ID,
		externalId: 9999,
		repositoryId: REPO_ID,
		title: "feat: user rewards active opps",
		authorLogin: "dev",
		authorAvatarUrl: null,
		requestedReviewers: "[]",
		status: "open",
		reviewStatus: "pending",
		sourceBranch: "feat/user-rewards-active-opps",
		targetBranch: "main",
		url: "https://github.com/angle-protocol/merkl-api/pull/9999",
		additions: 650,
		deletions: 5,
		changedFiles: 10,
		headSha: PR_HEAD_SHA,
		baseSha: "base-sha-001",
		createdAt: now,
		updatedAt: now,
		fetchedAt: now,
	})
	.onConflictDoNothing()
	.run();

db.insert(reviewSessions)
	.values({
		id: REVIEW_SESSION_ID,
		pullRequestId: PULL_REQUEST_ID,
		startedAt: now,
		status: "active",
	})
	.onConflictDoNothing()
	.run();

console.log("Seeded repo, PR, and review session rows.");

// Delete any existing walkthrough for this PR + SHA so we can do a clean re-run
db.delete(walkthroughs)
	.where(
		and(
			eq(walkthroughs.pullRequestId, PULL_REQUEST_ID),
			eq(walkthroughs.prHeadSha, PR_HEAD_SHA),
		),
	)
	.run();

// Insert a fresh walkthrough row
db.insert(walkthroughs)
	.values({
		id: WALKTHROUGH_ID,
		reviewSessionId: REVIEW_SESSION_ID,
		pullRequestId: PULL_REQUEST_ID,
		summary: "",
		riskLevel: "medium",
		status: "generating",
		generatedAt: now,
		modelUsed: "revv-ai-reviewer",
		tokenUsage: "{}",
		prHeadSha: PR_HEAD_SHA,
		lastCompletedPhase: "none",
	})
	.run();

console.log("Created walkthrough row in DB.");

// Build context
const events: WalkthroughStreamEvent[] = [];
const ctx: WalkthroughToolContext = {
	db,
	walkthroughId: WALKTHROUGH_ID,
	emit: (event: WalkthroughStreamEvent) => {
		events.push(event);
		console.log(`  [emit] ${event.type}`);
	},
	broadcastThreadEvent: (_msg: WsServerMessage) => {
		console.log(`  [broadcast] thread event`);
	},
};

// ── Helper ────────────────────────────────────────────────────────────────────

function printResult(
	name: string,
	result: { content: Array<{ text: string }>; isError?: boolean },
): string {
	const text = result.content[0]?.text ?? "(no content)";
	const status = result.isError ? "❌ ERROR" : "✅ OK";
	console.log(`\n[${name}] ${status}`);
	if (result.isError || text.length < 400) {
		console.log(`  ${text}`);
	} else {
		console.log(`  ${text.slice(0, 300)}...`);
	}
	if (result.isError) {
		console.error(`FATAL: ${name} failed. Aborting.`);
		process.exit(1);
	}
	return text;
}

function extractIssueId(text: string, name: string): string {
	const match = text.match(/id: ([a-f0-9]{64})/);
	const id = match?.[1] ?? "";
	if (!id) {
		console.error(`FATAL: could not extract issue_id from ${name}:`, text);
		process.exit(1);
	}
	console.log(`  Issue ID: ${id}`);
	return id;
}

// ── Step 0: get_walkthrough_state ─────────────────────────────────────────────

console.log("\n── Step 0: get_walkthrough_state ──");
const stateResult = await getWalkthroughStateHandler(ctx, {});
const stateText = printResult("get_walkthrough_state", stateResult);
console.log("\nFull state response:");
console.log(stateText);

// ── Phase A: set_overview ────────────────────────────────────────────────────

console.log("\n── Phase A: set_overview ──");
const overviewResult = await setOverviewHandler(ctx, {
	summary:
		"This PR adds a new endpoint `GET /users/:address/rewards/active-opportunities` that aggregates reward summaries across all opportunities with LIVE status for a given user address. The implementation queries a materialized view (`leaf_breakdown_amounts_per_recipient_opportunity`) for settled amounts (up to 30 min stale), merges live temp-leaf data for pending amounts, applies privacy masking via `CampaignService.checkAccessBatch`, and filters tokens (test-token and type-based filtering). Supporting additions include `LeanCampaign` formatter, `findLiveByOpportunityKeys` in campaign repository, `getBreakdownsByOpportunity` in leaf service, `amountsByRecipientOpportunity` in leafView repository, `findLiveByIds` in opportunity repository, and 363 lines of comprehensive tests.",
	risk_level: "medium",
});
printResult("set_overview", overviewResult);

// ── Phase B: diff steps (semantic chapters) ──────────────────────────────────

console.log("\n── Phase B: diff steps ──");

// ─── Chapter 0: Overview & Data Flow ─────────────────────────────────────────
console.log("\n  [Chapter 0] Overview & Data Flow");
const ch0 = await addSemanticStepHandler(ctx, {
	semantic_step_index: 0,
	title: "Endpoint overview and aggregation data flow",
	summary:
		"High-level overview of the new endpoint and how it combines materialized view data with live temp-leaf data.",
	initial_block: {
		markdown: {
			content: `## New Endpoint: \`GET /users/:address/rewards/active-opportunities\`

This PR introduces a cross-chain aggregator that returns all LIVE reward opportunities for a user where rewards are still owed. The aggregation uses a **two-source data model**:

1. **Materialized view** (\`leaf_breakdown_amounts_per_recipient_opportunity\`) — provides settled amounts and claimed amounts per (recipient, opportunity, token). Refreshed on a schedule; up to **30 minutes stale**.
2. **Live temp-leaf query** — provides pending (not-yet-settled) reward amounts for in-flight distributions.

The service merges these two data sources, applies **privacy masking** for restricted campaigns, and filters out noise (test tokens, zero-balance rows). The result is a ranked list of opportunities the user can act on.`,
		},
	},
});
printResult("add_semantic_step[0]", ch0);

// ─── Chapter 1: Pending Reconciliation Formula ────────────────────────────────
console.log("\n  [Chapter 1] Pending reconciliation formula");
const ch1 = await addSemanticStepHandler(ctx, {
	semantic_step_index: 1,
	title: "Pending reconciliation formula: pending = max(0, tempLeaf - (breakdown + liveDiff))",
	summary:
		"Analysis of the pending amount calculation and whether the formula correctly avoids double-counting.",
	initial_block: {
		markdown: {
			content: `## Pending Reconciliation Formula

The core challenge: temp-leaf rows represent *all* pending rewards for a distribution, but some portion may already appear as settled in the materialized view. To avoid double-counting, the service computes:

\`\`\`
pending = max(0, tempLeaf - (breakdown + liveDiff))
\`\`\`

Where:
- **\`tempLeaf\`** = raw sum of live temp-leaf amounts for (opportunity, token)
- **\`breakdown\`** = MV settled amount (may be stale by ≤30 min)
- **\`liveDiff\`** = any amounts distributed but not yet in the MV (bridge/sync gap)
- **\`max(0, ...)\`** = clamp to prevent negative pending values

This formula ensures that if the MV is ahead of temp-leaf (user already claimed), the pending contribution floors at zero rather than going negative.`,
		},
	},
});
printResult("add_semantic_step[1]", ch1);

const ch1b1 = await addDiffStepHandler(ctx, {
	semantic_step_index: 1,
	step_index: 1,
	diff: {
		file_path: "apps/api/src/modules/v4/user/user.service.ts",
		patch: `@@ -0,0 +1,35 @@
+// Pending reconciliation: avoid double-counting temp-leaf vs settled MV amounts
+const pendingByKey = new Map<string, bigint>(); // "chainId:oppId:tokenAddress" → pending
+for (const leaf of tempLeaves) {
+  const [chainId, campaignId] = leaf.campaignId.split(":");
+  const oppId = oppByCampaignKey.get(\`\${chainId}:\${campaignId}\`);
+  if (!oppId) continue;
+  const key = \`\${chainId}:\${oppId}:\${leaf.tokenAddress}\`;
+  pendingByKey.set(key, (pendingByKey.get(key) ?? 0n) + BigInt(leaf.amount));
+}
+
+// Merge: for each (opp, token) row from the MV, compute claimable + pending
+for (const row of breakdowns) {
+  const key = \`\${row.chainId}:\${row.id}:\${row.tokenAddress}\`;
+  const mvAmount = row.amount;       // settled in MV (stale up to 30 min)
+  const mvClaimed = row.claimed;     // claimed in MV (stale up to 30 min)
+  const rawPending = pendingByKey.get(key) ?? 0n;
+
+  // liveDiff: amount distributed since last MV refresh (may already be in tempLeaf)
+  const liveDiff = 0n; // NOTE: not yet implemented; potential future enhancement
+
+  // pending = max(0, tempLeaf - (breakdown + liveDiff))
+  const pending = rawPending > mvAmount + liveDiff
+    ? rawPending - (mvAmount + liveDiff)
+    : 0n;
+
+  // claimable = max(0, settled - already_claimed)
+  const claimable = mvAmount > mvClaimed ? mvAmount - mvClaimed : 0n;
+
+  if (claimable === 0n && pending === 0n) continue; // skip zero-balance rows
+  // ... accumulate into result
+}`,
		annotation:
			"The formula `pending = max(0, tempLeaf - (breakdown + liveDiff))` is mathematically sound for the common case. However, `liveDiff` is currently hardcoded to `0n` — it's a placeholder for a future enhancement. If `liveDiff` is ever implemented incorrectly, pending amounts could flip negative before the clamp. The clamp at `rawPending > mvAmount + liveDiff` is correct directionally but relies on all three values being in the same denomination (same token, same chain) — the key structure `chainId:oppId:tokenAddress` ensures this.",
		annotation_position: "right",
	},
});
printResult("add_diff_step[1,1]", ch1b1);

// ─── Chapter 2: Token Filtering ───────────────────────────────────────────────
console.log("\n  [Chapter 2] Token filtering");
const ch2 = await addSemanticStepHandler(ctx, {
	semantic_step_index: 2,
	title: "Token filtering: test-token and type-based exclusions",
	summary: "How test tokens and non-reward token types are filtered from results.",
	initial_block: {
		markdown: {
			content: `## Token Filtering

The service applies two layers of token filtering before accumulating rewards:

**1. Test-token filter** — Excludes tokens whose address appears in a hardcoded or config-driven test-token set. These are synthetic tokens used in staging/dev distributions that should never appear in production reward summaries.

**2. Token-type filter** — Only tokens of type \`ERC20\` (or the appropriate reward token type) are included. Non-standard token types (e.g., LP positions, NFTs) used as distribution vehicles but not as claimable rewards are excluded.

Both filters operate on the **token metadata** returned alongside the opportunity rows, not on the amount values. This means zero-amount rows for valid tokens still pass the filter (they'll be dropped later by the zero-balance check).`,
		},
	},
});
printResult("add_semantic_step[2]", ch2);

const ch2b1 = await addDiffStepHandler(ctx, {
	semantic_step_index: 2,
	step_index: 1,
	diff: {
		file_path: "apps/api/src/modules/v4/campaign/campaign.formatter.ts",
		patch: `@@ -0,0 +1,28 @@
+export type LeanCampaign = {
+  id: string;
+  opportunityId: string;
+  rewardTokenAddress: string;
+  rewardTokenType: TokenType;
+  isTestToken: boolean;
+};
+
+export const CampaignFormatter = {
+  // ... existing methods ...
+
+  formatLean(campaign: CampaignWithToken): LeanCampaign {
+    return {
+      id: campaign.id,
+      opportunityId: campaign.opportunityId,
+      rewardTokenAddress: campaign.rewardToken.address,
+      rewardTokenType: campaign.rewardToken.type,
+      isTestToken: campaign.rewardToken.isTest ?? false,
+    };
+  },
+};`,
		annotation:
			"`LeanCampaign` is a well-named projection type that carries only the fields needed for the active-opportunities aggregation. The `isTestToken: campaign.rewardToken.isTest ?? false` default handles campaigns where the token record has no `isTest` field — this is a safe default since untagged tokens are treated as real.",
		annotation_position: "left",
	},
});
printResult("add_diff_step[2,1]", ch2b1);

// ─── Chapter 3: Privacy Masking ───────────────────────────────────────────────
console.log("\n  [Chapter 3] Privacy masking");
const ch3 = await addSemanticStepHandler(ctx, {
	semantic_step_index: 3,
	title: "Privacy masking: multi-level access checks and placeholder deduplication",
	summary: "How restricted opportunities are masked and per-chain deduplication of private placeholders.",
	initial_block: {
		markdown: {
			content: `## Privacy Masking

After aggregating active opportunities, the service applies **multi-level privacy masking**:

1. **Batch access check**: \`CampaignService.checkAccessBatch(opportunityIds, userAddress)\` returns a map of \`{ [oppId]: { allowed: boolean } }\`. This is a single batched call — not N per-opportunity calls — which avoids an N+1 pattern.

2. **Per-chain placeholder deduplication**: For denied opportunities, a \`privateByChain\` map tracks one private placeholder object per chain ID. Multiple denied opportunities on the same chain collapse into a **single private card** in the response. This is intentional UI behavior: the user sees "1 private opportunity on Ethereum", not "3 private opportunities on Ethereum".

3. **Placeholder shape**: The private placeholder uses a sentinel \`id\` (e.g., \`"private-\${chainId}"\`) and a \`isPrivate: true\` flag so the UI can distinguish it from a real opportunity.`,
		},
	},
});
printResult("add_semantic_step[3]", ch3);

const ch3b1 = await addDiffStepHandler(ctx, {
	semantic_step_index: 3,
	step_index: 1,
	diff: {
		file_path: "apps/api/src/modules/v4/user/user.service.ts",
		patch: `@@ -0,0 +1,32 @@
+// Privacy masking pass
+const opportunityIds = activeRows.map(r => r.id);
+const accessMap = await CampaignService.checkAccessBatch(opportunityIds, address);
+
+const privateByChain = new Map<number, UserActiveOpportunityDto>();
+const result: UserActiveOpportunityDto[] = [];
+
+for (const row of activeRows) {
+  const access = accessMap[row.id];
+  if (!access?.allowed) {
+    // Denied: create or reuse the per-chain private placeholder
+    if (!privateByChain.has(row.chainId)) {
+      privateByChain.set(row.chainId, {
+        id: \`private-\${row.chainId}\`,
+        chainId: row.chainId,
+        isPrivate: true,
+        claimable: "0",
+        pending: "0",
+        // ... other required fields zeroed out
+      });
+    }
+    // NOTE: push the placeholder once per chain, handled below
+    continue;
+  }
+  result.push(formatActiveOpportunity(row));
+}
+
+// Add one private placeholder per chain that had at least one denied opp
+for (const placeholder of privateByChain.values()) {
+  result.push(placeholder);
+}`,
		annotation:
			"The two-pass approach (collect denied → push placeholders at the end) correctly produces exactly one private placeholder per chain, regardless of how many denied opportunities exist on that chain. The `continue` inside the denial branch prevents the denied opportunity from being pushed to `result` directly — only the placeholder gets pushed via the `privateByChain.values()` loop at the end. This is the right pattern.",
		annotation_position: "right",
	},
});
printResult("add_diff_step[3,1]", ch3b1);

// ─── Chapter 4: Materialized View Staleness ───────────────────────────────────
console.log("\n  [Chapter 4] Materialized view staleness");
const ch4 = await addSemanticStepHandler(ctx, {
	semantic_step_index: 4,
	title: "Materialized view staleness: 30-min lag and client visibility",
	summary: "The MV refresh cadence, its implications for stale data, and whether clients are informed.",
	initial_block: {
		markdown: {
			content: `## Materialized View Staleness

The \`leaf_breakdown_amounts_per_recipient_opportunity\` materialized view is refreshed on a schedule (approximately every 30 minutes, triggered from \`refresh-materialized-views.ts\`). This means:

- **Settled amounts** in the response may be up to **30 minutes stale**.
- A user who **claimed rewards** within the last 30 min may still see those amounts as "claimable" — the clamp formula ensures they won't see *negative* claimable, but they may see stale *positive* claimable.
- A user who **received new rewards** within the last 30 min won't see them in the MV amounts — they'll only appear in the \`pending\` amount via the live temp-leaf path.

The MV is correct for performance: scanning the full leaf table on every request would be prohibitively expensive. The staleness is an accepted trade-off, but **clients are not informed** of this trade-off.`,
		},
	},
});
printResult("add_semantic_step[4]", ch4);

const ch4b1 = await addDiffStepHandler(ctx, {
	semantic_step_index: 4,
	step_index: 1,
	diff: {
		file_path: "apps/api/src/jobs/refresh-materialized-views.ts",
		patch: `@@ -0,0 +1,18 @@
+// Added: refresh leaf_breakdown_amounts_per_recipient_opportunity
+export async function refreshMaterializedViews(): Promise<void> {
+  await apiDbClient.$executeRaw\`
+    REFRESH MATERIALIZED VIEW CONCURRENTLY
+    leaf_breakdown_amounts_per_recipient_opportunity
+  \`;
+  logger.info("Refreshed leaf_breakdown_amounts_per_recipient_opportunity");
+}`,
		annotation:
			"`REFRESH MATERIALIZED VIEW CONCURRENTLY` is the correct PostgreSQL command for a non-blocking refresh — it allows reads to continue from the old snapshot while the new data is being computed. This avoids locking the view during the 30-minute refresh window. The trade-off is that the new data isn't visible until the full refresh completes, so clients always read a consistent (if stale) snapshot.",
		annotation_position: "left",
	},
});
printResult("add_diff_step[4,1]", ch4b1);

// FLAG: MV staleness not surfaced to client
console.log("\n  [flag_issue] MV staleness not surfaced to client");
const issue1Result = await flagIssueHandler(ctx, {
	severity: "warning",
	title: "MV staleness (≤30 min) not surfaced to API clients",
	description:
		"The active-opportunities response mixes MV settled amounts (up to 30 min stale) with live pending amounts but provides no staleness signal. Clients cannot show freshness indicators or warn users about potentially stale claimable values.",
	block_refs: [
		{ semantic_step_index: 4, step_index: 0 },
		{ semantic_step_index: 4, step_index: 1 },
	],
	file_path: "apps/api/src/modules/v4/user/user.controller.ts",
	start_line: null,
	end_line: null,
});
const issue1Text = printResult("flag_issue[MV staleness]", issue1Result);
const issue1Id = extractIssueId(issue1Text, "flag_issue[MV staleness]");

console.log("\n  [add_issue_comment] MV staleness");
await addIssueCommentHandler(ctx, {
	issue_id: issue1Id,
	file_path: "apps/api/src/modules/v4/user/user.controller.ts",
	start_line: 1,
	end_line: 1,
	diff_side: "new",
	body: "The settled amounts in this response come from the `leaf_breakdown_amounts_per_recipient_opportunity` materialized view, which can be up to 30 minutes stale. The response has `setCacheHeaders(0)` (no-cache) which prevents browser caching, but there is no signal to the client about the *data freshness* of the MV amounts themselves.\n\nConsider adding:\n- A `dataAsOf: string` (ISO timestamp) top-level field in the response DTO, populated from the MV's last-refresh timestamp.\n- Or a custom `X-Data-As-Of` response header.\n\nThis allows dashboards to show a \"rewards data as of N minutes ago\" indicator and helps users understand why a recently-claimed reward still shows as claimable.",
});
printResult("add_issue_comment[MV staleness]", { content: [{ text: "ok" }] });

// ─── Chapter 5: leafView.repository + amountsByRecipientOpportunity ───────────
console.log("\n  [Chapter 5] leafView.repository raw SQL");
const ch5 = await addSemanticStepHandler(ctx, {
	semantic_step_index: 5,
	title: "leafView.repository: raw SQL query on materialized view",
	summary: "How the materialized view is queried and the risks of using $queryRawUnsafe.",
	initial_block: {
		diff: {
			file_path: "apps/api/src/modules/v4/leaf/leafView.repository.ts",
			patch: `@@ -0,0 +1,40 @@
+export abstract class LeafViewRepository {
+  static async amountsByRecipientOpportunity(
+    recipient: string,
+    chainId?: number,
+  ): Promise<Array<{
+    opportunityId: string;
+    tokenAddress: string;
+    amount: bigint;
+    claimed: bigint;
+  }>> {
+    const rows = await apiDbClient.$queryRawUnsafe<Array<{
+      opportunity_id: string;
+      token_address: string;
+      amount: string;
+      claimed: string;
+    }>>(
+      chainId !== undefined
+        ? \`SELECT opportunity_id, token_address, amount, claimed
+           FROM leaf_breakdown_amounts_per_recipient_opportunity
+           WHERE recipient = $1 AND chain_id = $2\`
+        : \`SELECT opportunity_id, token_address, amount, claimed
+           FROM leaf_breakdown_amounts_per_recipient_opportunity
+           WHERE recipient = $1\`,
+      recipient,
+      ...(chainId !== undefined ? [chainId] : []),
+    );
+    return rows.map(r => ({
+      opportunityId: r.opportunity_id,
+      tokenAddress: r.token_address,
+      amount: BigInt(r.amount),
+      claimed: BigInt(r.claimed),
+    }));
+  }
+}`,
			annotation:
				"Uses `$queryRawUnsafe` with Prisma's parameterized `$1/$2` placeholders — SQL injection is not possible since user input is bound via parameters. However, the raw SQL approach bypasses Prisma's type system: column names (e.g., `opportunity_id`) are string literals not validated at compile time. A schema migration that renames a column would produce a silent runtime failure (returning `undefined` values) rather than a TypeScript error. Consider adding a runtime shape assertion or using a Prisma view model if the schema stabilizes.",
			annotation_position: "right",
		},
	},
});
printResult("add_semantic_step[5]", ch5);

// ─── Chapter 6: campaign.repository findLiveByOpportunityKeys ─────────────────
console.log("\n  [Chapter 6] Campaign repository + opportunity repository additions");
const ch6 = await addSemanticStepHandler(ctx, {
	semantic_step_index: 6,
	title: "Repository additions: findLiveByOpportunityKeys and findLiveByIds",
	summary: "New query methods added to campaign and opportunity repositories.",
	initial_block: {
		diff: {
			file_path: "apps/api/src/modules/v4/campaign/campaign.repository.ts",
			patch: `@@ -0,0 +1,22 @@
+  static async findLiveByOpportunityKeys(
+    keys: string[],
+  ): Promise<CampaignWithToken[]> {
+    if (keys.length === 0) return [];
+    return apiDbClient.campaign.findMany({
+      where: {
+        opportunity: {
+          uniqueKey: { in: keys },
+          status: "LIVE",
+        },
+        endTimestamp: { gt: Math.floor(Date.now() / 1000) },
+      },
+      include: {
+        rewardToken: true,
+      },
+    });
+  }`,
			annotation:
				"The `endTimestamp: { gt: Math.floor(Date.now() / 1000) }` filter ensures only active campaigns (not yet ended) are returned. Combined with `status: 'LIVE'` on the opportunity, this double-gates the query. One concern: `Math.floor(Date.now() / 1000)` is evaluated at query time in JS — if there's significant clock skew between the API server and the DB server, campaigns near the boundary may behave inconsistently. This is a minor concern for a timestamp-gated filter.",
			annotation_position: "left",
		},
	},
});
printResult("add_semantic_step[6]", ch6);

const ch6b1 = await addDiffStepHandler(ctx, {
	semantic_step_index: 6,
	step_index: 1,
	diff: {
		file_path: "apps/api/src/modules/v4/opportunity/opportunity.repository.ts",
		patch: `@@ -0,0 +1,18 @@
+  static async findLiveByIds(
+    ids: string[],
+  ): Promise<OpportunityWithRelations[]> {
+    if (ids.length === 0) return [];
+    return apiDbClient.opportunity.findMany({
+      where: {
+        id: { in: ids },
+        status: "LIVE",
+      },
+      include: {
+        MainProtocol: true,
+        Chain: true,
+        Tokens: true,
+        ActivePrograms: true,
+      },
+    });
+  }`,
		annotation:
			"Early-return on empty array (`if (ids.length === 0) return []`) is consistent with the rest of the repository layer and prevents `WHERE id IN ()` syntax errors in SQL. The LIVE status filter at the DB layer is correct — it ensures retired opportunities are never surfaced even if their IDs appear in the input list.",
		annotation_position: "right",
	},
});
printResult("add_diff_step[6,1]", ch6b1);

// ─── Chapter 7: user.model DTOs ───────────────────────────────────────────────
console.log("\n  [Chapter 7] Response DTO shape");
const ch7 = await addSemanticStepHandler(ctx, {
	semantic_step_index: 7,
	title: "Response DTO: UserActiveOpportunitiesResourceDto shape and stability",
	summary: "The API contract shape for the new endpoint and whether it's stable.",
	initial_block: {
		diff: {
			file_path: "apps/api/src/modules/v4/user/user.model.ts",
			patch: `@@ -0,0 +1,42 @@
+export const UserActiveOpportunityDto = t.Object({
+  id: t.String(),
+  chainId: t.Number(),
+  isPrivate: t.Optional(t.Boolean()),
+  opportunityIdentifier: t.Optional(t.String()),
+  protocol: t.Optional(t.Object({
+    id: t.String(),
+    name: t.String(),
+    logoUrl: t.Optional(t.String()),
+  })),
+  tokens: t.Optional(t.Array(t.Object({
+    address: t.String(),
+    symbol: t.String(),
+    decimals: t.Number(),
+    logoUrl: t.Optional(t.String()),
+  }))),
+  claimable: t.String(),   // bigint serialized as decimal string
+  pending: t.String(),     // bigint serialized as decimal string
+  apr: t.Optional(t.Number()),
+  dailyRewards: t.Optional(t.Number()),
+});
+
+export const UserActiveOpportunitiesResourceDto = t.Array(UserActiveOpportunityDto);`,
			annotation:
				"All bigint fields (`claimable`, `pending`) are correctly serialized as decimal strings — this avoids JSON precision loss for large reward amounts. The `isPrivate` and most detail fields are marked `t.Optional`, which means the private placeholder shape is a subset of the full opportunity shape. This is clean: clients check `isPrivate === true` and know to expect missing detail fields.",
			annotation_position: "left",
		},
	},
});
printResult("add_semantic_step[7]", ch7);

// ─── Chapter 8: Test Coverage ─────────────────────────────────────────────────
console.log("\n  [Chapter 8] Test coverage");
const ch8 = await addSemanticStepHandler(ctx, {
	semantic_step_index: 8,
	title: "Test coverage: 363 lines covering critical edge cases",
	summary: "Overview of the test file and assessment of coverage quality.",
	initial_block: {
		markdown: {
			content: `## Test Coverage: \`user.service.test.ts\` (+363 lines)

The PR ships 363 lines of unit tests covering the new \`getActiveOpportunities\` service method. Coverage assessment:

**✅ Well-covered paths:**
- Happy path (user with live rewards across multiple opportunities)
- **Claimable clamping** when MV is stale (claimed > amount → clamp to 0, not negative)
- **Test-token filtering** (isTestToken === true rows excluded from result)
- **Token-type filtering** (non-ERC20 tokens excluded)
- **Privacy masking** deduplication (multiple denied opps on same chain → one private placeholder)
- Empty result when no live rewards exist
- Multi-token opportunities (single opp with multiple reward tokens)

**⚠️ Gaps noted:**
- No test for the MV + temp-leaf interaction when the **same token** appears in both (double-count prevention via the pending formula)
- No test for **very large** amounts near BigInt overflow (defensive, but worth a future test)
- No integration test confirming the MV refresh job correctly triggers \`REFRESH MATERIALIZED VIEW CONCURRENTLY\``,
		},
	},
});
printResult("add_semantic_step[8]", ch8);

const ch8b1 = await addDiffStepHandler(ctx, {
	semantic_step_index: 8,
	step_index: 1,
	diff: {
		file_path: "apps/api/tests/v4/user/user.service.test.ts",
		patch: `@@ -0,0 +1,45 @@
+describe("UserService.getActiveOpportunities", () => {
+  describe("claimable clamping", () => {
+    it("returns claimable=0 when MV claimed > MV amount (stale MV after recent claim)", async () => {
+      mockMvAmounts.mockResolvedValueOnce([{
+        opportunityId: "opp-1",
+        tokenAddress: "0xtoken",
+        amount: 50n,   // MV shows 50 settled
+        claimed: 100n, // MV shows 100 claimed (MV lagging — user already claimed 100)
+      }]);
+      const result = await UserService.getActiveOpportunities("0xuser", {});
+      expect(result.find(r => r.id === "opp-1")?.claimable).toBe("0");
+    });
+  });
+
+  describe("token filtering", () => {
+    it("excludes test tokens from result", async () => {
+      // campaign with isTestToken=true should not appear in result
+      mockFindLiveByOpportunityKeys.mockResolvedValueOnce([
+        { id: "c1", rewardToken: { isTest: true, address: "0xtest", type: "ERC20" } },
+      ]);
+      const result = await UserService.getActiveOpportunities("0xuser", {});
+      expect(result).toHaveLength(0);
+    });
+  });
+
+  describe("privacy masking", () => {
+    it("collapses multiple denied opps on same chain into one private placeholder", async () => {
+      mockCheckAccessBatch.mockResolvedValueOnce({
+        "opp-A": { allowed: false },
+        "opp-B": { allowed: false }, // same chainId as opp-A
+      });
+      const result = await UserService.getActiveOpportunities("0xuser", {});
+      const privateCards = result.filter(r => r.isPrivate === true);
+      expect(privateCards).toHaveLength(1); // not 2
+      expect(privateCards[0]?.id).toBe("private-1"); // chain 1 placeholder
+    });
+  });
+});`,
		annotation:
			"These three test cases directly cover the three highest-risk behaviors in the service: MV staleness handling, token exclusion safety, and privacy placeholder deduplication. The claimable-clamping test uses a concrete scenario (50 settled, 100 claimed) that matches the real staleness failure mode. The privacy test explicitly checks `toHaveLength(1)` (not 2) which is the regression guard for the deduplication logic.",
		annotation_position: "right",
	},
});
printResult("add_diff_step[8,1]", ch8b1);

// ─── Chapter 9: leaf.service getBreakdownsByOpportunity ───────────────────────
console.log("\n  [Chapter 9] leaf.service orchestration");
const ch9 = await addSemanticStepHandler(ctx, {
	semantic_step_index: 9,
	title: "leaf.service: getBreakdownsByOpportunity parallel query orchestration",
	summary: "How the leaf service combines opportunity metadata with MV amounts in parallel.",
	initial_block: {
		diff: {
			file_path: "apps/api/src/modules/v4/leaf/leaf.service.ts",
			patch: `@@ -0,0 +1,38 @@
+  static async getBreakdownsByOpportunity(
+    recipient: string,
+    chainId: number,
+  ): Promise<BreakdownsByOpportunityRow[]> {
+    const [opportunities, mvAmounts] = await Promise.all([
+      OpportunityRepository.findLiveByIds(
+        await LeafViewRepository.amountsByRecipientOpportunity(recipient, chainId)
+          .then(rows => [...new Set(rows.map(r => r.opportunityId))]),
+      ),
+      LeafViewRepository.amountsByRecipientOpportunity(recipient, chainId),
+    ]);
+
+    const amountByKey = new Map(
+      mvAmounts.map(r => [\`\${r.opportunityId}:\${r.tokenAddress}\`, r]),
+    );
+
+    return opportunities.flatMap(opp =>
+      (opp.Tokens ?? [])
+        .filter(token => !token.isTest && token.type === "ERC20")
+        .map(token => {
+          const key = \`\${opp.id}:\${token.address}\`;
+          const mv = amountByKey.get(key);
+          return {
+            ...opp,
+            tokenAddress: token.address,
+            amount: mv?.amount ?? 0n,
+            claimed: mv?.claimed ?? 0n,
+          };
+        })
+    );
+  }`,
			annotation:
				"`LeafViewRepository.amountsByRecipientOpportunity` is called **twice** in the `Promise.all` — once to extract opportunity IDs for the `findLiveByIds` query, and again to get the amounts for the join. This is redundant: the same DB query runs twice per request. The fix is to call it once, store the result, extract IDs from the stored result, and pass the stored result to `findLiveByIds`. This is a minor performance issue since the MV query is indexed on `recipient + chain_id`, but it is still wasteful.",
			annotation_position: "right",
		},
	},
});
printResult("add_semantic_step[9]", ch9);

// FLAG: Double MV query
console.log("\n  [flag_issue] Double MV query in getBreakdownsByOpportunity");
const issue2Result = await flagIssueHandler(ctx, {
	severity: "warning",
	title: "LeafViewRepository.amountsByRecipientOpportunity called twice per request",
	description:
		"In leaf.service.ts getBreakdownsByOpportunity, the MV query is issued twice within a single Promise.all — once to extract opportunity IDs and again to get amounts for the join. The same data is fetched redundantly on every request.",
	block_refs: [
		{ semantic_step_index: 9, step_index: 0 },
	],
	file_path: "apps/api/src/modules/v4/leaf/leaf.service.ts",
	start_line: null,
	end_line: null,
});
const issue2Text = printResult("flag_issue[double MV query]", issue2Result);
const issue2Id = extractIssueId(issue2Text, "flag_issue[double MV query]");

console.log("\n  [add_issue_comment] double MV query");
await addIssueCommentHandler(ctx, {
	issue_id: issue2Id,
	file_path: "apps/api/src/modules/v4/leaf/leaf.service.ts",
	start_line: 1,
	end_line: 1,
	diff_side: "new",
	body: "`LeafViewRepository.amountsByRecipientOpportunity` is called twice inside `Promise.all` — once to derive the list of opportunity IDs for `findLiveByIds`, and a second time to build the `amountByKey` join map. Both calls execute the same SQL against the same materialized view.\n\nFix: call it once, await the result, then use the result for both purposes:\n```typescript\nconst mvAmounts = await LeafViewRepository.amountsByRecipientOpportunity(recipient, chainId);\nconst uniqueOppIds = [...new Set(mvAmounts.map(r => r.opportunityId))];\nconst opportunities = await OpportunityRepository.findLiveByIds(uniqueOppIds);\n```\nThis halves the number of DB round-trips for this method.",
});
printResult("add_issue_comment[double MV query]", { content: [{ text: "ok" }] });

// ── Phase C: set_sentiment ────────────────────────────────────────────────────

console.log("\n── Phase C: set_sentiment ──");
const sentimentResult = await setSentimentHandler(ctx, {
	markdown:
		"This PR is well-structured and ships comprehensive test coverage for a non-trivial aggregation feature. The pending reconciliation formula (`max(0, tempLeaf - (breakdown + liveDiff))`) is mathematically correct, the privacy masking two-pass pattern is sound, and the clampable/zero-balance filtering is properly tested. Two issues should be addressed before merge: **(1)** `LeafViewRepository.amountsByRecipientOpportunity` is invoked twice per request in `leaf.service.ts` — this should be deduplicated to a single call; **(2)** the response provides no staleness signal (no `dataAsOf` field, no `X-Data-As-Of` header) despite MV data being up to 30 min stale, which could confuse users who recently claimed rewards. Both are straightforward fixes. The rest of the implementation — repository layer, DTO shape, token filtering, and test coverage — is solid.",
});
printResult("set_sentiment", sentimentResult);

// ── Phase D: rate_axis (all 9) ────────────────────────────────────────────────

console.log("\n── Phase D: rate_axis (9 axes) ──");

// 1. correctness
const r1 = await rateAxisHandler(ctx, {
	axis: "correctness",
	verdict: "pass",
	confidence: "medium",
	rationale:
		"The pending formula `max(0, tempLeaf - (breakdown + liveDiff))` correctly prevents double-counting and negative values. BigInt serialization to decimal strings is safe.",
	details:
		"The claimable clamp (`mvAmount > mvClaimed ? mvAmount - mvClaimed : 0n`) correctly handles the MV staleness edge case where claimed > amount. The pending formula floors at 0n preventing negative pending values. BigInt arithmetic is used throughout (no floating-point precision issues). The `findLiveByIds` early return on empty array prevents SQL IN() errors. The `flatMap` over tokens generates one row per (opp, token) pair correctly. `liveDiff` is hardcoded to `0n` which is a placeholder — the comment is honest about this being a future enhancement.",
	citations: [
		{
			file_path: "apps/api/src/modules/v4/user/user.service.ts",
			start_line: 1,
			end_line: 30,
			note: "Pending reconciliation formula and claimable clamp",
		},
	],
	block_refs: [{ semantic_step_index: 1, step_index: 1 }],
});
printResult("rate_axis[correctness]", r1);

// 2. scope
const r2 = await rateAxisHandler(ctx, {
	axis: "scope",
	verdict: "pass",
	confidence: "high",
	rationale:
		"Single focused endpoint + supporting repository layer + DTOs + tests. No unrelated changes.",
	details:
		"The PR adds exactly one new endpoint (`GET /users/:address/rewards/active-opportunities`), the required repository methods (`findLiveByOpportunityKeys`, `findLiveByIds`, `amountsByRecipientOpportunity`, `getBreakdownsByOpportunity`), a lean formatter type (`LeanCampaign`/`formatLean`), the response DTO (`UserActiveOpportunitiesResourceDto`), and the corresponding service method (`getActiveOpportunities`). The MV refresh addition is a necessary infrastructure change. No drive-by refactors or unrelated formatting changes were identified.",
	citations: [],
	block_refs: [],
});
printResult("rate_axis[scope]", r2);

// 3. tests
const r3 = await rateAxisHandler(ctx, {
	axis: "tests",
	verdict: "pass",
	confidence: "high",
	rationale:
		"363 lines covering happy paths, claimable clamping, token filtering, privacy masking dedup, and empty states.",
	details:
		"The test suite covers all the critical behaviors: claimable clamping (amount < claimed edge case), test-token exclusion, token-type filtering, privacy placeholder deduplication per chain, and the empty-result case. The claimable-clamping test with concrete values (50 settled, 100 claimed → 0 claimable) is the most important regression guard and it's present. The one gap is the absence of a test for the double-counting prevention formula (MV + temp-leaf same token), but this is a minor gap for an otherwise thorough suite.",
	citations: [
		{
			file_path: "apps/api/tests/v4/user/user.service.test.ts",
			start_line: 1,
			end_line: 363,
			note: "363-line test file",
		},
	],
	block_refs: [{ semantic_step_index: 8, step_index: 1 }],
});
printResult("rate_axis[tests]", r3);

// 4. clarity
const r4 = await rateAxisHandler(ctx, {
	axis: "clarity",
	verdict: "concern",
	confidence: "medium",
	rationale:
		"`getActiveOpportunities` is long (~150 lines) with multiple nested maps. The double MV query in leaf.service is confusing.",
	details:
		"The `getActiveOpportunities` method in `user.service.ts` is the most complex addition. Two nested `Map` structures (`oppByCampaignKey` and `pendingByKey`) require careful reading to follow the attribution chain. The pending formula is not commented. The double call to `amountsByRecipientOpportunity` in `leaf.service.ts` inside `Promise.all` creates a misleading parallel structure that actually runs the same query twice — this is both a clarity and performance issue. Consider extracting the pending attribution logic into a named helper function and fixing the double query.",
	citations: [
		{
			file_path: "apps/api/src/modules/v4/leaf/leaf.service.ts",
			start_line: 1,
			end_line: 38,
			note: "Double MV query inside Promise.all",
		},
	],
	block_refs: [{ semantic_step_index: 9, step_index: 0 }],
});
printResult("rate_axis[clarity]", r4);

// 5. safety
const r5 = await rateAxisHandler(ctx, {
	axis: "safety",
	verdict: "concern",
	confidence: "medium",
	rationale:
		"MV staleness (≤30 min) is not surfaced to clients. Users may see stale claimable amounts without knowing the data is stale.",
	details:
		"The `leaf_breakdown_amounts_per_recipient_opportunity` MV can be up to 30 minutes stale. A user who claimed rewards recently may see those rewards as still claimable in the response. The clamp prevents negative values (good) but does not warn the client that the data may be stale. Additionally, `$queryRawUnsafe` in `leafView.repository.ts` bypasses Prisma's schema validation — a column rename would cause a silent runtime failure. The `$queryRawUnsafe` parameterization correctly prevents SQL injection, so this is a safety-of-correctness concern rather than a security concern.",
	citations: [
		{
			file_path: "apps/api/src/modules/v4/leaf/leafView.repository.ts",
			start_line: 1,
			end_line: 40,
			note: "$queryRawUnsafe with schema-unvalidated column names",
		},
	],
	block_refs: [
		{ semantic_step_index: 4, step_index: 0 },
		{ semantic_step_index: 5, step_index: 0 },
	],
});
printResult("rate_axis[safety]", r5);

// 6. consistency
const r6 = await rateAxisHandler(ctx, {
	axis: "consistency",
	verdict: "pass",
	confidence: "high",
	rationale:
		"Follows existing patterns: abstract repository classes, static async service methods, Elysia DTO shapes, `setCacheHeaders(0)` in `beforeHandle`.",
	details:
		"The new `LeafViewRepository` mirrors the `abstract class` pattern used by `LeafRepository`. Service methods are static async functions consistent with `UserService`. The `beforeHandle` pattern with `setCacheHeaders(0)` + `throwOnInvalidRequiredAddress` matches all adjacent routes in `user.controller.ts`. The `t.Optional` DTO fields follow the existing Elysia schema style. `LeanCampaign` follows the naming convention of other Lean* projection types in the codebase.",
	citations: [],
	block_refs: [],
});
printResult("rate_axis[consistency]", r6);

// 7. api_changes
const r7 = await rateAxisHandler(ctx, {
	axis: "api_changes",
	verdict: "pass",
	confidence: "high",
	rationale:
		"Additive only — one new GET route. No existing route signatures, DTOs, or response shapes were modified.",
	details:
		"The new `GET /users/:address/rewards/active-opportunities` endpoint is purely additive. No existing endpoint signatures, query parameter shapes, or response DTOs were changed. The new `UserActiveOpportunitiesResourceDto` is a new array DTO with no overlap with existing DTOs. The endpoint is guarded by the same address validation (`throwOnInvalidRequiredAddress`) as all other user routes.",
	citations: [],
	block_refs: [{ semantic_step_index: 7, step_index: 0 }],
});
printResult("rate_axis[api_changes]", r7);

// 8. performance
const r8 = await rateAxisHandler(ctx, {
	axis: "performance",
	verdict: "concern",
	confidence: "high",
	rationale:
		"`amountsByRecipientOpportunity` is called twice per request in `leaf.service.ts`. Batched access check and MV use are otherwise good performance choices.",
	details:
		"The double call to `LeafViewRepository.amountsByRecipientOpportunity` inside `Promise.all` in `leaf.service.ts` executes the same SQL query twice per endpoint invocation. While the MV query is fast (indexed on `recipient + chain_id`), there is no reason to run it twice. Fix: call it once, store the result, extract IDs, then call `findLiveByIds`. Otherwise, the performance profile is good: MV avoids a full leaf table scan, `checkAccessBatch` is a single batched call, and `findLiveByIds` correctly early-returns on empty input.",
	citations: [
		{
			file_path: "apps/api/src/modules/v4/leaf/leaf.service.ts",
			start_line: 1,
			end_line: 38,
			note: "Duplicate MV query in Promise.all",
		},
	],
	block_refs: [{ semantic_step_index: 9, step_index: 0 }],
});
printResult("rate_axis[performance]", r8);

// 9. description
const r9 = await rateAxisHandler(ctx, {
	axis: "description",
	verdict: "concern",
	confidence: "low",
	rationale:
		"No PR description was available in this review context to assess the 'why', deployment notes, or migration steps.",
	details:
		"The code is self-documenting and the controller registrations use OpenAPI `detail` blocks. However, no PR body was available to assess deployment notes, migration steps (the new MV needs to be created before this code can run), or links to related issues. The MV `leaf_breakdown_amounts_per_recipient_opportunity` is a new database object — its creation DDL should be documented in the PR description or in a migration file. The PR should call out the MV refresh job addition (`refresh-materialized-views.ts`) and its scheduling impact.",
	citations: [
		{
			file_path: "apps/api/src/jobs/refresh-materialized-views.ts",
			start_line: 1,
			end_line: 18,
			note: "New MV refresh job — deployment impact not documented",
		},
	],
	block_refs: [{ semantic_step_index: 4, step_index: 1 }],
});
printResult("rate_axis[description]", r9);

// ── Finish: complete_walkthrough ──────────────────────────────────────────────

console.log("\n── Finish: complete_walkthrough ──");
const completeResult = await completeWalkthroughHandler(ctx, {});
printResult("complete_walkthrough", completeResult);

// Mark walkthrough as complete in DB (orchestrator's job in production)
console.log("\nMarking walkthrough as complete in DB...");
db.update(walkthroughs)
	.set({ status: "complete" })
	.where(eq(walkthroughs.id, WALKTHROUGH_ID))
	.run();

console.log(
	`\n✅ Pipeline complete! Walkthrough ${WALKTHROUGH_ID} is now 'complete'.`,
);
console.log(`Total events emitted: ${events.length}`);
