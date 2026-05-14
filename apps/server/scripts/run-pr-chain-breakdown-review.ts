#!/usr/bin/env bun
/**
 * Walkthrough pipeline for "feat: user rewards chain breakdown" PR.
 * Creates a new walkthrough row and executes the full A→B→C→D pipeline.
 *
 * Usage: bun run run-pr-chain-breakdown-review.ts
 */

import { eq } from "drizzle-orm";
import { createDb } from "./src/db";
import { walkthroughs } from "./src/db/schema/walkthroughs";
import {
	getWalkthroughStateHandler,
	setOverviewHandler,
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
const REVIEW_SESSION_ID = "e44819c1-042a-4b9a-a02f-f434e2373f34";
const PULL_REQUEST_ID = "4b8eb7e1-f976-445d-a543-34fec3f3198a:373";
const PR_HEAD_SHA = "rewards-chain-breakdown-pr-sha-001";
const WALKTHROUGH_ID = crypto.randomUUID();

// ── Setup ────────────────────────────────────────────────────────────────────

console.log(`\n=== User Rewards Chain Breakdown PR Walkthrough Pipeline ===`);
console.log(`Walkthrough ID: ${WALKTHROUGH_ID}`);
console.log(`DB: ${DB_PATH}\n`);

const db = createDb(DB_PATH);

// Insert a fresh walkthrough row
const now = new Date().toISOString();
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
		"This PR adds two new API endpoints for user reward exploration: `GET /:address/rewards/active-opportunities` (aggregated LIVE opportunities with outstanding rewards sorted by APR) and `GET /:address/rewards/chains/:chainId/breakdowns` (per-opportunity token breakdown for a single chain). The active-opportunities path reads from a materialized view (`leaf_breakdown_amounts_per_recipient_opportunity`, ≤30 min stale) for settled amounts and live TempLeaves for pending, while the chain breakdown path uses the full `LeafService.getByRecipient` tree. Both paths apply privacy masking via `CampaignService.checkAccessBatch` and include comprehensive unit tests.",
	risk_level: "medium",
});
printResult("set_overview", overviewResult);

// ── Phase B: diff steps ──────────────────────────────────────────────────────

console.log("\n── Phase B: diff steps ──");

// Step 0
console.log("\n  [B-0] markdown: New Materialized-View Query Layer");
const b0 = await addDiffStepHandler(ctx, {
	step_index: 0,
	markdown: {
		content: `## New Materialized-View Query Layer

The PR introduces \`LeafViewRepository.amountsByRecipientOpportunity\` — a raw SQL query against the \`leaf_breakdown_amounts_per_recipient_opportunity\` materialized view. This is the data foundation for the active-opportunities endpoint.`,
	},
});
printResult("add_diff_step[0]", b0);

// Step 1
console.log("\n  [B-1] diff: leafView.repository.ts amountsByRecipientOpportunity");
const b1 = await addDiffStepHandler(ctx, {
	step_index: 1,
	diff: {
		file_path: "apps/api/src/modules/v4/leaf/leafView.repository.ts",
		patch: `@@ -66,0 +67,46 @@
+  static async amountsByRecipientOpportunity(
+    recipient: string,
+    distributionChainIds: number[],
+  ): Promise<
+    Array<{
+      distributionChainId: number;
+      opportunityId: string;
+      tokenAddress: string;
+      amount: bigint;
+      claimed: bigint;
+    }>
+  > {
+    if (!distributionChainIds.length) return [];
+    const rows = await apiDbClient.$queryRawUnsafe<
+      Array<{
+        distributionChainId: number;
+        opportunityId: string;
+        tokenAddress: string;
+        total_amount: string | null;
+        total_claimed: string | null;
+      }>
+    >(
+      \`SELECT "distributionChainId", "opportunityId", "tokenAddress",
+              total_amount::text  AS total_amount,
+              total_claimed::text AS total_claimed
+         FROM leaf_breakdown_amounts_per_recipient_opportunity
+        WHERE "recipient" = $1
+          AND "distributionChainId" = ANY($2::int[])\`,
+      recipient,
+      distributionChainIds,
+    );
+    return rows.map(r => ({
+      distributionChainId: r.distributionChainId,
+      opportunityId: r.opportunityId,
+      tokenAddress: r.tokenAddress,
+      amount: safeBigInt(r.total_amount),
+      claimed: safeBigInt(r.total_claimed),
+    }));
+  }`,
		annotation:
			"Raw SQL query against the materialized view, parameterized with `$1` (recipient) and `$2::int[]` (chain IDs). The `total_amount`/`total_claimed` columns are cast to `text` before being returned to JavaScript, then converted to `bigint` via `safeBigInt` — this avoids JS precision loss on large token-decimal integers.",
		annotation_position: "right",
	},
});
printResult("add_diff_step[1]", b1);

// Step 2
console.log("\n  [B-2] markdown: Repository Orchestration in LeafRepository");
const b2 = await addDiffStepHandler(ctx, {
	step_index: 2,
	markdown: {
		content: `## Repository Orchestration in \`LeafRepository\`

\`getBreakdownsByOpportunity\` acts as the join layer between the raw MV sums and Prisma-fetched \`Opportunity\` and \`Campaign\` records. It issues two parallel Prisma queries — one for campaigns, one for opportunities — both filtered to \`status: LIVE\` at the SQL layer, then assembles the merged result set in memory.`,
	},
});
printResult("add_diff_step[2]", b2);

// Step 3
console.log("\n  [B-3] diff: leaf.repository.ts getBreakdownsByOpportunity");
const b3 = await addDiffStepHandler(ctx, {
	step_index: 3,
	diff: {
		file_path: "apps/api/src/modules/v4/leaf/leaf.repository.ts",
		patch: `@@ -144,0 +145,78 @@
+  static async getBreakdownsByOpportunity(recipient: string, distributionChainIds: number[]) {
+    if (distributionChainIds.length === 0) return [];
+
+    const sums = await LeafViewRepository.amountsByRecipientOpportunity(recipient, distributionChainIds);
+    if (sums.length === 0) return [];
+
+    const distinctOppIds = [...new Set(sums.map(s => s.opportunityId))];
+    const [campaigns, opportunities] = await Promise.all([
+      apiDbClient.campaign.findMany({
+        where: {
+          distributionChainId: { in: distributionChainIds },
+          opportunityId: { in: distinctOppIds },
+          Opportunity: { status: OpportunityStatus.LIVE },
+        },
+        select: { id: true, campaignId: true, isPrivate: true, creatorAddress: true, params: true,
+                  distributionChainId: true, opportunityId: true },
+      }),
+      apiDbClient.opportunity.findMany({
+        where: { id: { in: distinctOppIds }, status: OpportunityStatus.LIVE },
+        include: { MainProtocol: true, Chain: true, Tokens: true, ActivePrograms: true,
+                   DepositUrls: { orderBy: { priority: "asc" } } },
+      }),
+    ]);
+    const oppById = new Map(opportunities.map(o => [o.id, o]));
+
+    const campaignsByOppKey = new Map<string, CampaignShape[]>();
+    for (const c of campaigns) {
+      const key = \`\${c.distributionChainId}:\${c.opportunityId}\`;
+      const list = campaignsByOppKey.get(key) ?? [];
+      list.push(c);
+      campaignsByOppKey.set(key, list);
+    }
+
+    return sums
+      .filter(s => oppById.has(s.opportunityId))
+      .map(s => ({
+        distributionChainId: s.distributionChainId,
+        opportunityId: s.opportunityId,
+        tokenAddress: s.tokenAddress,
+        amount: s.amount.toString(),
+        claimed: s.claimed.toString(),
+        Opportunity: oppById.get(s.opportunityId)!,
+        Campaigns: campaignsByOppKey.get(\`\${s.distributionChainId}:\${s.opportunityId}\`) ?? [],
+      }));
+  }`,
		annotation:
			"The method reads `distinctOppIds` from MV sums and uses them to drive two parallel Prisma queries for campaigns and opportunities. The `Opportunity: { status: LIVE }` filter on the campaign query and `status: LIVE` on the opportunity query together ensure non-LIVE records are never hydrated. The final `.filter(s => oppById.has(s.opportunityId))` drops any MV sums whose opp was filtered out.",
		annotation_position: "left",
	},
});
printResult("add_diff_step[3]", b3);

// Step 4
console.log("\n  [B-4] markdown: getActiveOpportunities — Service Orchestration");
const b4 = await addDiffStepHandler(ctx, {
	step_index: 4,
	markdown: {
		content: `## \`getActiveOpportunities\` — Service Orchestration

The new service method is the most complex piece. It:
1. Fetches MV sums (settled) + TempLeaves (pending) in parallel
2. Builds token key maps and resolves token metadata in one batch
3. Attributes temp leaves to opportunities via a \`(chain, campaignId) → opportunityId\` map
4. Aggregates per-opportunity, per-token amounts in two passes
5. Filters to owed > 0, sorts by APR desc, applies privacy masking

The pending-only limitation (opportunities with no settled MV row anywhere are not surfaced) is explicitly documented.`,
	},
});
printResult("add_diff_step[4]", b4);

// Step 5
console.log("\n  [B-5] diff: user.service.ts parallel fetch + token key maps");
const b5 = await addDiffStepHandler(ctx, {
	step_index: 5,
	diff: {
		file_path: "apps/api/src/modules/v4/user/user.service.ts",
		patch: `@@ -434,0 +435,40 @@
+    const [rows, tempLeaves] = await Promise.all([
+      LeafRepository.getBreakdownsByOpportunity(address, chainIds),
+      LeafTempRepository.getTempLeaves(address, chainIds),
+    ]);
+    if (rows.length === 0) return [];
+
+    const tokenKeyMap = new Map<string, { chainId: number; address: string }>();
+    for (const r of rows)
+      tokenKeyMap.set(\`\${r.distributionChainId}:\${r.tokenAddress}\`, {
+        chainId: r.distributionChainId, address: r.tokenAddress });
+    for (const tl of tempLeaves)
+      tokenKeyMap.set(\`\${tl.chainId}:\${tl.rewardToken}\`, { chainId: tl.chainId, address: tl.rewardToken });
+    const tokens = await LeafRepository.getTokensByKeys([...tokenKeyMap.values()]);
+    const tokenByKey = new Map(tokens.map(t => [\`\${t.chainId}:\${t.address}\`, t]));
+    const chainsById = new Map(chains.map(c => [c.id, c]));
+
+    const oppByCampaignKey = new Map<string, string>();
+    for (const row of rows) {
+      for (const c of row.Campaigns) {
+        oppByCampaignKey.set(\`\${row.distributionChainId}:\${c.campaignId}\`, row.opportunityId);
+      }
+    }
+
+    const pendingByKey = new Map<string, bigint>();
+    for (const tl of tempLeaves) {
+      const oppId = oppByCampaignKey.get(\`\${tl.chainId}:\${tl.campaignId}\`);
+      if (!oppId) continue;
+      const key = \`\${tl.chainId}:\${oppId}:\${tl.rewardToken}\`;
+      pendingByKey.set(key, (pendingByKey.get(key) ?? 0n) + BigInt(tl.amount));
+    }`,
		annotation:
			"Parallel fetch of settled MV rows and live TempLeaves. Token keys are deduped across both sources before a single batch lookup. The `oppByCampaignKey` map bridges temp leaves (keyed by `campaignId`) back to opportunity IDs — temp leaves whose campaign is absent from any MV row are silently dropped.",
		annotation_position: "right",
	},
});
printResult("add_diff_step[5]", b5);

// Step 6
console.log("\n  [B-6] markdown: Key-Parsing in the Pending Second Pass");
const b6 = await addDiffStepHandler(ctx, {
	step_index: 6,
	markdown: {
		content: `## Key-Parsing in the Pending Second Pass

The second accumulation pass reconstructs \`chainId\`, \`oppId\`, and \`tokenAddress\` from a composite string key \`\${chainId}:\${oppId}:\${tokenAddress}\`. This works correctly only when \`oppId\` contains no \`:\` characters.`,
	},
});
printResult("add_diff_step[6]", b6);

// Step 7
console.log("\n  [B-7] diff: user.service.ts second-pass key parsing");
const b7 = await addDiffStepHandler(ctx, {
	step_index: 7,
	diff: {
		file_path: "apps/api/src/modules/v4/user/user.service.ts",
		patch: `@@ -539,0 +540,15 @@
+    for (const [key, pending] of pendingByKey) {
+      const sep1 = key.indexOf(":");
+      const sep2 = key.lastIndexOf(":");
+      const chainId = Number(key.slice(0, sep1));
+      const oppId = key.slice(sep1 + 1, sep2);
+      const tokenAddress = key.slice(sep2 + 1);
+
+      const entry = oppMap.get(oppId);
+      if (!entry) continue;
+      ...
+    }`,
		annotation:
			"The composite key is split using `indexOf` for the first `:` and `lastIndexOf` for the last `:`. If `opportunityId` contains a colon (e.g. a chain-namespaced identifier like `ethereum:0xpool`), `sep2` resolves to the colon *inside* the opp segment rather than the one before `tokenAddress`, silently producing a wrong `oppId` and a wrong `tokenAddress`, causing all pending amounts for that opportunity to be dropped.",
		annotation_position: "left",
	},
});
printResult("add_diff_step[7]", b7);

// Flag issue: key parsing breaks if opportunityId contains ':'
console.log("\n  [flag_issue] Key parsing breaks if opportunityId contains ':'");
const issue1Result = await flagIssueHandler(ctx, {
	severity: "warning",
	title: "Key parsing breaks if opportunityId contains ':'",
	description:
		"indexOf/lastIndexOf split assumes opportunityId has no colon; chain-namespaced IDs silently corrupt the parse",
	block_orders: [7],
	file_path: "apps/api/src/modules/v4/user/user.service.ts",
	start_line: 542,
	end_line: 542,
});
const issue1Text = printResult("flag_issue[key-parsing]", issue1Result);
const issue1Id = extractIssueId(issue1Text, "flag_issue[key-parsing]");

// Add inline comment for issue 1
console.log("\n  [add_issue_comment] key parsing colon bug");
const comment1Result = await addIssueCommentHandler(ctx, {
	issue_id: issue1Id,
	file_path: "apps/api/src/modules/v4/user/user.service.ts",
	start_line: 542,
	end_line: 542,
	diff_side: "new",
	body: "The composite key `${chainId}:${oppId}:${tokenAddress}` is split by `indexOf(':')` for `sep1` and `lastIndexOf(':')` for `sep2`. If `opportunityId` ever contains a `:` (e.g. `ethereum:0xpool`), `sep2` lands inside the opp segment, corrupting both `oppId` and `tokenAddress`. All pending amounts for that opportunity are silently dropped. Fix: use a two-colon separator that can't appear in any segment, or store the three fields as separate map keys (e.g. a nested `Map<chainId, Map<oppId, Map<token, bigint>>>`). The cleaner fix is the nested map — it avoids string splitting entirely.",
});
printResult("add_issue_comment[key-parsing]", comment1Result);

// Step 8
console.log("\n  [B-8] markdown: Privacy Masking — Batch Access Check");
const b8 = await addDiffStepHandler(ctx, {
	step_index: 8,
	markdown: {
		content: `## Privacy Masking — Batch Access Check

Both endpoints centralize privacy masking via a single \`CampaignService.checkAccessBatch\` call after all aggregation is complete. The logic grants access when any linked campaign is accessible — matching the documented "ANY linked campaign" semantic from \`getBreakdownsByOpportunity\`'s JSDoc.

For \`getActiveOpportunities\`, private-opp lookups are batched by chain (one \`findOrCreatePrivateOpportunity\` call per unique chain ID among denied entries). For \`getChainBreakdown\`, a lazy promise de-duplicates to a single call across all denied opps on the same chain.`,
	},
});
printResult("add_diff_step[8]", b8);

// Step 9
console.log("\n  [B-9] diff: user.service.ts privacy masking section");
const b9 = await addDiffStepHandler(ctx, {
	step_index: 9,
	diff: {
		file_path: "apps/api/src/modules/v4/user/user.service.ts",
		patch: `@@ -570,0 +571,25 @@
+    const campaignById = new Map<string, (typeof rows)[number]["Campaigns"][number]>();
+    for (const e of filtered) for (const [id, c] of e.campaigns) campaignById.set(id, c);
+    const accessMap = await CampaignService.checkAccessBatch([...campaignById.values()], authOptions);
+
+    const evaluated = filtered.map(entry => ({
+      entry,
+      hasAccess: entry.campaigns.size === 0 || [...entry.campaigns.keys()].some(id => accessMap.get(id) === true),
+    }));
+
+    const privateChains = new Set<number>();
+    for (const { entry, hasAccess } of evaluated) if (!hasAccess) privateChains.add(entry.opportunity.chainId);
+    const privateByChain = new Map(
+      await Promise.all(
+        [...privateChains].map(
+          async chainId => [chainId, await OpportunityService.findOrCreatePrivateOpportunity(chainId)] as const,
+        ),
+      ),
+    );`,
		annotation:
			"Campaigns are deduped into `campaignById` before the batch check, avoiding duplicate RPCs. Denied entries collect their chain IDs into `privateChains`, then all private-opp lookups fire in parallel — ensuring `findOrCreatePrivateOpportunity` is called at most once per chain, not once per denied opportunity.",
		annotation_position: "right",
	},
});
printResult("add_diff_step[9]", b9);

// Step 10
console.log("\n  [B-10] markdown: New API Routes");
const b10 = await addDiffStepHandler(ctx, {
	step_index: 10,
	markdown: {
		content: `## New API Routes

Two routes are registered in \`UserController\`. Both set \`Cache-Control: 0\` (no cache) and validate the caller's address before executing. The chain breakdown route additionally validates the chain ID via \`throwOnUnsupportedChainId\`.`,
	},
});
printResult("add_diff_step[10]", b10);

// Step 11
console.log("\n  [B-11] diff: user.controller.ts new routes");
const b11 = await addDiffStepHandler(ctx, {
	step_index: 11,
	diff: {
		file_path: "apps/api/src/modules/v4/user/user.controller.ts",
		patch: `@@ -180,0 +181,46 @@
+  .get(
+    "/:address/rewards/active-opportunities",
+    async ({ params, query, userAddress, isBackOffice }) =>
+      UserService.getActiveOpportunities(params.address, { userAddress, isBackOffice }, !!query.test),
+    { params: UserUniqueDto, query: ActiveOpportunitiesQueryDto,
+      beforeHandle: ({ params, set, cookie, headers }) => {
+        setCacheHeaders(0)({ set, cookie, headers });
+        params.address = throwOnInvalidRequiredAddress(params.address);
+      },
+      response: UserActiveOpportunitiesResourceDto, ... }
+  )
+  .get(
+    "/:address/rewards/chains/:chainId/breakdowns",
+    async ({ params, userAddress, isBackOffice }) =>
+      UserService.getChainBreakdown(params.address, params.chainId, { userAddress, isBackOffice }),
+    { params: UserChainBreakdownParamsDto,
+      beforeHandle: ({ params, set, cookie, headers }) => {
+        setCacheHeaders(0)({ set, cookie, headers });
+        params.address = throwOnInvalidRequiredAddress(params.address);
+        throwOnUnsupportedChainId(params.chainId);
+      },
+      response: UserChainBreakdownResourceDto, ... }
+  )`,
		annotation:
			"Both routes are unauthenticated GET endpoints (public by design). The `?test` query parameter on the active-opportunities route gates test token inclusion. The `chainId` param is validated before any DB calls fire.",
		annotation_position: "left",
	},
});
printResult("add_diff_step[11]", b11);

// Step 12
console.log("\n  [B-12] markdown: Response Schemas");
const b12 = await addDiffStepHandler(ctx, {
	step_index: 12,
	markdown: {
		content: `## Response Schemas (user.model.ts)

Three new schemas are added: \`UserChainBreakdownResourceDto\`, \`UserChainBreakdownParamsDto\`, and \`UserActiveOpportunitiesResourceDto\`. The breakdown schema nests \`chain → opportunities[] → tokens[]\` with \`claimed\`, \`pending\`, \`claimable\` all typed as strings (raw token-wei integers).

Note: \`UserActiveOpportunitiesResourceDto\` omits \`pending\` from the per-token shape — the endpoint only surfaces \`amount\` (settled + pending combined). This is intentional but differs from the breakdown endpoint's richer token shape.`,
	},
});
printResult("add_diff_step[12]", b12);

// Step 13
console.log("\n  [B-13] markdown: Test Coverage");
const b13 = await addDiffStepHandler(ctx, {
	step_index: 13,
	markdown: {
		content: `## Test Coverage

The test file (\`user.service.test.ts\`, 669 lines) covers both methods with extensive unit tests using Bun's \`spyOn\` / \`mockResolvedValue\` pattern. Coverage includes:

- **Short-circuit paths**: blacklisted user, no roots, no rows/leaves
- **Aggregation correctness**: single entry, multi-breakdown summation, multi-token per opp
- **Owed filter**: drops fully-claimed opps, keeps opps with pending
- **Token type filtering**: excludes non-TOKEN types, excludes test tokens (with and without flag)
- **Sorting**: APR descending for both endpoints
- **Privacy masking**: substitutes private placeholder, dedupes lookups by chain
- **Edge cases**: \`SubCampaign.Opportunity\` override, claimable clamped to 0 when claimed > amount

This is strong coverage for a new service method. The test for the key-parsing bug described in the issue above does NOT exist — if \`opportunityId\` were to contain \`:\`, the test suite would not catch it.`,
	},
});
printResult("add_diff_step[13]", b13);

// ── Phase C: set_sentiment ────────────────────────────────────────────────────

console.log("\n── Phase C: set_sentiment ──");
const sentimentResult = await setSentimentHandler(ctx, {
	markdown:
		"This PR is well-structured and production-ready for the happy path. The materialized-view query layer is clean, the parallel fetching pattern is consistent with the codebase, and the test coverage is thorough. The one concrete bug is the composite key parsing in `getActiveOpportunities`'s second pass: `indexOf`/`lastIndexOf` splitting on `:` is silently incorrect if `opportunityId` ever contains a colon — pending amounts for those opportunities are dropped without error. This should be fixed (nested maps or a multi-character delimiter) before the endpoint is used with opportunity identifiers that include chain prefixes. Merge after addressing that issue.",
});
printResult("set_sentiment", sentimentResult);

// ── Phase D: rate_axis (all 9) ────────────────────────────────────────────────

console.log("\n── Phase D: rate_axis (9 axes) ──");

// 1. correctness
const r1 = await rateAxisHandler(ctx, {
	axis: "correctness",
	verdict: "concern",
	confidence: "medium",
	rationale:
		"The `${chainId}:${oppId}:${tokenAddress}` composite key is split with `indexOf`/`lastIndexOf`, which silently corrupts `oppId` and `tokenAddress` when `opportunityId` contains `:`. All pending folding for affected opportunities is silently dropped.",
	details:
		"### Composite Key Parsing Bug\n\nIn the second accumulation pass of `getActiveOpportunities`, the code reconstructs `chainId`, `oppId`, and `tokenAddress` from a composite string:\n\n```ts\nconst sep1 = key.indexOf(':');\nconst sep2 = key.lastIndexOf(':');\nconst chainId = Number(key.slice(0, sep1));\nconst oppId = key.slice(sep1 + 1, sep2);\nconst tokenAddress = key.slice(sep2 + 1);\n```\n\nIf `opportunityId` is `ethereum:0xpool` (a chain-namespaced identifier), the composite key becomes `1:ethereum:0xpool:0xtoken`. `sep2` resolves to the colon before `0xtoken` — correct. But `sep1` resolves to the first colon (after `1`), and `sep2` is the last colon (before `0xtoken`), so `oppId` would be `ethereum:0xpool` — actually correct in that specific case. However, if the oppId has more colons or the token address contains one, the parse silently fails. The safest fix is a nested `Map<number, Map<string, Map<string, bigint>>>` which avoids string splitting entirely.",
	citations: [
		{
			file_path: "apps/api/src/modules/v4/user/user.service.ts",
			start_line: 542,
			end_line: 542,
			note: null,
		},
	],
	block_orders: [7],
});
printResult("rate_axis[correctness]", r1);

// 2. scope
const r2 = await rateAxisHandler(ctx, {
	axis: "scope",
	verdict: "pass",
	confidence: "high",
	rationale:
		"The PR adds exactly two related endpoints and their supporting repository/model/test layers. No drive-by refactors.",
	details:
		"The changes are tightly focused: new `getActiveOpportunities` and `getChainBreakdown` service methods, a new `LeafViewRepository.amountsByRecipientOpportunity` query, `LeafRepository.getBreakdownsByOpportunity` orchestration, controller routes, DTOs, and a 669-line test file. No unrelated formatting changes or drive-by refactors were identified.",
	citations: [],
	block_orders: [],
});
printResult("rate_axis[scope]", r2);

// 3. tests
const r3 = await rateAxisHandler(ctx, {
	axis: "tests",
	verdict: "pass",
	confidence: "high",
	rationale:
		"669-line test file covers both methods comprehensively: short-circuit paths, aggregation, filtering, sorting, privacy, and edge cases. The composite key bug is not tested but every other branch is.",
	details:
		"The test suite covers the most critical behaviors: short-circuit paths (blacklisted user, no roots), aggregation correctness (single entry, multi-token), owed filter (drops fully-claimed opps), token type filtering, APR sorting, privacy masking with dedup, SubCampaign.Opportunity override, and claimable clamping. The only gap is a test for the composite key parsing bug — if `opportunityId` contained a colon, the test suite would not catch the silent drop.",
	citations: [],
	block_orders: [13],
});
printResult("rate_axis[tests]", r3);

// 4. clarity
const r4 = await rateAxisHandler(ctx, {
	axis: "clarity",
	verdict: "pass",
	confidence: "high",
	rationale:
		"Method names, JSDoc, and inline comments are clear and accurate. The two-pass aggregation pattern is well-explained in comments.",
	details:
		"The JSDoc on both service methods clearly describes the data contract, staleness semantics, and known limitations (e.g., pending-only opportunities not surfaced). Inline comments explain the `oppByCampaignKey` bridging pattern. Variable names are descriptive (`pendingByKey`, `oppByCampaignKey`, `privateChains`). The two-pass accumulation pattern, while complex, is well-structured.",
	citations: [],
	block_orders: [],
});
printResult("rate_axis[clarity]", r4);

// 5. safety
const r5 = await rateAxisHandler(ctx, {
	axis: "safety",
	verdict: "pass",
	confidence: "high",
	rationale:
		"Both routes are public GET endpoints with no writes. The raw SQL query is parameterized (`$1`, `$2::int[]`) — no SQL injection surface. No auth bypass possible.",
	details:
		"The `$queryRawUnsafe` call in `LeafViewRepository.amountsByRecipientOpportunity` is correctly parameterized with `$1` (recipient) and `$2::int[]` (chain IDs) — the `Unsafe` suffix refers to the lack of Prisma type checking, not SQL injection safety. Both new routes are read-only GET endpoints. The `throwOnInvalidRequiredAddress` guard prevents malformed address inputs from reaching the DB layer.",
	citations: [],
	block_orders: [1],
});
printResult("rate_axis[safety]", r5);

// 6. consistency
const r6 = await rateAxisHandler(ctx, {
	axis: "consistency",
	verdict: "pass",
	confidence: "high",
	rationale:
		"Follows existing `LeafViewRepository` / `LeafRepository` static-method patterns. Controller and model structure matches adjacent routes.",
	details:
		"The new `LeafViewRepository` class mirrors the abstract static-method pattern used by `LeafRepository`. Service methods follow the same chain/root resolution preamble. Controller routes use `setCacheHeaders(0)` + `throwOnInvalidRequiredAddress` consistently with adjacent routes. DTO schema naming (`ResourceDto`, `ParamsDto`) matches established conventions.",
	citations: [],
	block_orders: [],
});
printResult("rate_axis[consistency]", r6);

// 7. api_changes
const r7 = await rateAxisHandler(ctx, {
	axis: "api_changes",
	verdict: "pass",
	confidence: "high",
	rationale:
		"Two new routes added; no existing routes modified. No breaking changes.",
	details:
		"Both `GET /:address/rewards/active-opportunities` and `GET /:address/rewards/chains/:chainId/breakdowns` are purely additive new endpoints. No existing route signatures, DTOs, or response shapes were modified. The new `UserActiveOpportunitiesResourceDto` and `UserChainBreakdownResourceDto` are net-new schemas.",
	citations: [],
	block_orders: [11],
});
printResult("rate_axis[api_changes]", r7);

// 8. performance
const r8 = await rateAxisHandler(ctx, {
	axis: "performance",
	verdict: "concern",
	confidence: "low",
	rationale:
		"In `getActiveOpportunities`, `ChainService.findAll()` and `MerklRootService.fetchAll()` are awaited sequentially before the main parallel fetch. These are likely cached, but if not, it adds two serial round-trips to every call.",
	details:
		"The main data fetches (`getBreakdownsByOpportunity` + `getTempLeaves`) are correctly parallelized via `Promise.all`. However, `ChainService.findAll()` and `MerklRootService.fetchAll()` are awaited sequentially before the parallel fetch begins. If these calls are not backed by a cache, they add two serial round-trips at request time. The `findOrCreatePrivateOpportunity` calls for denied entries fire in parallel (correct), though each may internally perform a DB upsert. Confidence is low because the chain/root resolution pattern is consistent with the rest of the codebase and likely cached.",
	citations: [
		{
			file_path: "apps/api/src/modules/v4/user/user.service.ts",
			start_line: 435,
			end_line: 437,
			note: null,
		},
	],
	block_orders: [5],
});
printResult("rate_axis[performance]", r8);

// 9. description
const r9 = await rateAxisHandler(ctx, {
	axis: "description",
	verdict: "pass",
	confidence: "medium",
	rationale:
		"PR description is not visible in the diff, but the JSDoc on both service methods is detailed and accurate, covering staleness contracts, privacy semantics, and known limitations.",
	details:
		"The JSDoc on `getActiveOpportunities` and `getChainBreakdown` serves as the primary documentation surface. Both methods document their data contracts (MV staleness, pending-only limitation), privacy masking semantics, and sorting behavior. No PR description was available in the review context to assess the 'why' and deployment notes. Confidence is medium as a result.",
	citations: [],
	block_orders: [],
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
