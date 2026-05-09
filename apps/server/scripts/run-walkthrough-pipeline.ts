/**
 * Direct walkthrough pipeline runner.
 * Calls tool handlers in-process, bypassing the HTTP/auth layer.
 * Usage: bun run scripts/run-walkthrough-pipeline.ts <walkthroughId>
 */

import { createDb } from "../src/db";
import {
	getWalkthroughStateHandler,
	setOverviewHandler,
	addDiffStepHandler,
	flagIssueHandler,
	addIssueCommentHandler,
	setSentimentHandler,
	rateAxisHandler,
	completeWalkthroughHandler,
} from "../src/ai/providers/walkthrough-tools";
import type { WalkthroughToolContext } from "../src/ai/providers/walkthrough-tool-spec";

const walkthroughId = process.argv[2];
if (!walkthroughId) {
	console.error("Usage: bun run scripts/run-walkthrough-pipeline.ts <walkthroughId>");
	process.exit(1);
}

const db = createDb();

const ctx: WalkthroughToolContext = {
	db,
	walkthroughId,
	emit: (event) => {
		console.log(`[EMIT] ${event.type}`);
	},
	broadcastThreadEvent: (msg) => {
		console.log(`[BROADCAST] ${JSON.stringify(msg).slice(0, 80)}`);
	},
};

function printResult(toolName: string, result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
	const text = result.content.map(c => c.text).join("\n");
	const status = result.isError ? "ERROR" : "OK";
	console.log(`\n[${status}] ${toolName}: ${text.slice(0, 200)}`);
	if (result.isError) {
		console.error("FATAL: tool returned error, stopping.");
		process.exit(1);
	}
}

async function main() {
	// Step 0: get_walkthrough_state
	console.log("\n=== Phase 0: get_walkthrough_state ===");
	const state = await getWalkthroughStateHandler(ctx, {});
	printResult("get_walkthrough_state", state);
	const stateText = state.content[0]?.text ?? "{}";
	const parsed = JSON.parse(stateText.startsWith("WARNING") ? stateText.split("\n\n")[1]! : stateText) as { lastCompletedPhase: string };
	console.log(`Current phase: ${parsed.lastCompletedPhase}`);

	if (parsed.lastCompletedPhase !== "none") {
		console.log("Walkthrough already started — resuming is not supported in this script yet.");
		process.exit(0);
	}

	// Phase A: set_overview
	console.log("\n=== Phase A: set_overview ===");
	const overviewResult = await setOverviewHandler(ctx, {
		summary: "This PR introduces a new `GET /:address/rewards/active-opportunities` endpoint that aggregates a user's LIVE reward opportunities with per-token earned amounts (settled + pending). It adds a materialized view `leaf_breakdown_amounts_per_recipient_opportunity` (≤30 min staleness), lean campaign/opportunity repository methods, and a substantial `UserService.getActiveOpportunities` implementation that merges MV data with live temp-leaves, applies privacy masking, and filters to opportunities with outstanding rewards.",
		risk_level: "medium",
	});
	printResult("set_overview", overviewResult);

	// Phase B: diff steps
	console.log("\n=== Phase B: diff steps ===");

	// Step 0
	const s0 = await addDiffStepHandler(ctx, {
		step_index: 0,
		markdown: {
			content: "## Materialized View Refresh Registration\n\nThe pipeline begins at the infrastructure layer: a new MV refresh is registered alongside the existing recipient-aggregation views.",
		},
	});
	printResult("add_diff_step[0]", s0);

	// Step 1
	const s1 = await addDiffStepHandler(ctx, {
		step_index: 1,
		diff: {
			file_path: "apps/api/src/jobs/refresh-materialized-views.ts",
			patch: `@@ -23,6 +23,9 @@ async function main() {
     await apiDbClient.$executeRawUnsafe("REFRESH MATERIALIZED VIEW CONCURRENTLY leaf_amounts_per_token");
     await apiDbClient.$executeRawUnsafe("REFRESH MATERIALIZED VIEW CONCURRENTLY leaf_breakdown_count_per_recipient");
+    await apiDbClient.$executeRawUnsafe(
+      "REFRESH MATERIALIZED VIEW CONCURRENTLY leaf_breakdown_amounts_per_recipient_opportunity",
+    );
 
     // Engine DB views`,
			annotation: "The new MV `leaf_breakdown_amounts_per_recipient_opportunity` is added to the refresh batch alongside existing recipient-keyed views. No DDL for this view is included in this PR — it must already exist in the database before this job runs.",
			annotation_position: "right",
		},
	});
	printResult("add_diff_step[1]", s1);

	// Step 2
	const s2 = await addDiffStepHandler(ctx, {
		step_index: 2,
		markdown: {
			content: "## Lean Campaign Type and Formatter\n\nTo avoid pulling full Campaign DTOs for privacy checks and opportunity rollups, a minimal `LeanCampaign` shape is introduced.",
		},
	});
	printResult("add_diff_step[2]", s2);

	// Step 3
	const s3 = await addDiffStepHandler(ctx, {
		step_index: 3,
		diff: {
			file_path: "apps/api/src/modules/v4/campaign/campaign.formatter.ts",
			patch: `@@ -18,6 +18,28 @@ import { CampaignWithOpportunityResourceDto } from "../opportunity/opportunity.m
 import type { DailyRewardsBreakdown } from "../reward/reward.model";
 import type { CampaignRepository } from "./campaign.repository";
 
+export type LeanCampaign = {
+  id: string;
+  campaignId: string;
+  isPrivate: boolean;
+  creatorAddress: string;
+  params: EngineCampaign<CampaignType>["campaignParameters"];
+  distributionChainId: number;
+  opportunityId: string | null;
+};
+
+type LeanCampaignInput = {
+  id: string;
+  campaignId: string;
+  isPrivate: boolean;
+  creatorAddress: string;
+  params: unknown;
+  distributionChainId: number;
+  opportunityId: string | null;
+};
+
+  static formatLean(campaign: LeanCampaignInput): LeanCampaign {
+    return {
+      ...
+      params: campaign.params as EngineCampaign<CampaignType>["campaignParameters"],
+      ...
+    };
+  }`,
			annotation: "`LeanCampaignInput` accepts `params: unknown` from Prisma's JSON column, and `formatLean` casts it to the typed union. This is the same unsafe cast pattern used elsewhere in the formatter — correctness depends on DB integrity.",
			annotation_position: "left",
		},
	});
	printResult("add_diff_step[3]", s3);

	// Step 4
	const s4 = await addDiffStepHandler(ctx, {
		step_index: 4,
		markdown: {
			content: "## Repository Methods: LIVE-filtered Queries\n\nTwo new repository methods push the LIVE-status filter to SQL, avoiding JS-side status checks on hydrated rows.",
		},
	});
	printResult("add_diff_step[4]", s4);

	// Step 5
	const s5 = await addDiffStepHandler(ctx, {
		step_index: 5,
		diff: {
			file_path: "apps/api/src/modules/v4/campaign/campaign.repository.ts",
			patch: `+  static async findLiveByOpportunityKeys(distributionChainIds: number[], opportunityIds: string[]) {
+    if (distributionChainIds.length === 0 || opportunityIds.length === 0) return [];
+    const rows = await apiDbClient.campaign.findMany({
+      where: {
+        distributionChainId: { in: distributionChainIds },
+        opportunityId: { in: opportunityIds },
+        Opportunity: { status: OpportunityStatus.LIVE },
+      },
+      select: { id, campaignId, isPrivate, creatorAddress, params, distributionChainId, opportunityId },
+    });
+    return rows.map(c => CampaignFormatter.formatLean(c));
+  }`,
			annotation: "`findLiveByOpportunityKeys` uses a cross-filter on `distributionChainId` and `opportunityId` — this is a cartesian AND (not per-pair matching), so a campaign on chainId=1 for oppId='opp-B' would be returned even if the caller only cared about (chainId=1, 'opp-A') and (chainId=10, 'opp-B').",
			annotation_position: "right",
		},
	});
	printResult("add_diff_step[5]", s5);

	// flag_issue after step 5
	const fi1 = await flagIssueHandler(ctx, {
		severity: "warning",
		title: "findLiveByOpportunityKeys uses cartesian cross-filter, not per-pair matching",
		description: "IN(chainIds) × IN(oppIds) may return campaigns for (chainId, oppId) pairs not in the input set",
		block_orders: [5],
		file_path: "apps/api/src/modules/v4/campaign/campaign.repository.ts",
		start_line: 108,
		end_line: 115,
	});
	printResult("flag_issue[1]", fi1);

	// Extract issue id from response
	const fi1Text = fi1.content[0]?.text ?? "";
	const fi1IdMatch = /id: ([a-f0-9]+)/.exec(fi1Text);
	const fi1Id = fi1IdMatch?.[1] ?? "";
	console.log(`Issue 1 ID: ${fi1Id}`);

	// add_issue_comment for issue 1
	const ic1 = await addIssueCommentHandler(ctx, {
		issue_id: fi1Id,
		file_path: "apps/api/src/modules/v4/campaign/campaign.repository.ts",
		start_line: 108,
		end_line: 115,
		diff_side: "right",
		body: "The `WHERE distributionChainId IN (...) AND opportunityId IN (...)` filter is a cartesian product, not a per-pair match. If your caller has pairs `[(chainId=1, oppA), (chainId=10, oppB)]`, this query also returns campaigns for `(chainId=1, oppB)` and `(chainId=10, oppA)` if they exist. In practice this likely causes no bug here (campaigns for non-matching pairs will just find no MV rows and be silently dropped), but it is semantically incorrect and could become a real issue if the result is used for security decisions like privacy masking. Consider filtering in JS after the query, or restructuring as a raw SQL query with `(chainId, oppId) IN (VALUES ...)` pairs.",
	});
	printResult("add_issue_comment[1]", ic1);

	// Step 6
	const s6 = await addDiffStepHandler(ctx, {
		step_index: 6,
		markdown: {
			content: "## LeafView Repository: MV Query\n\nThe new `amountsByRecipientOpportunity` method reads from the materialized view using a raw SQL query.",
		},
	});
	printResult("add_diff_step[6]", s6);

	// Step 7
	const s7 = await addDiffStepHandler(ctx, {
		step_index: 7,
		diff: {
			file_path: "apps/api/src/modules/v4/leaf/leafView.repository.ts",
			patch: `+  static async amountsByRecipientOpportunity(
+    recipient: string,
+    distributionChainIds: number[],
+  ) {
+    const rows = await apiDbClient.$queryRawUnsafe<...>(
+      \`SELECT "distributionChainId", "opportunityId", "tokenAddress",
+              total_amount::text AS total_amount,
+              total_claimed::text AS total_claimed
+         FROM leaf_breakdown_amounts_per_recipient_opportunity
+        WHERE "recipient" = $1
+          AND "distributionChainId" = ANY($2::int[])\`,
+      recipient,
+      distributionChainIds,
+    );
+    return rows.map(r => ({
+      ...
+      amount: safeBigInt(r.total_amount),
+      claimed: safeBigInt(r.total_claimed),
+    }));
+  }`,
			annotation: "Raw SQL query on the MV uses parameterized inputs for both `recipient` and `distributionChainIds`, avoiding SQL injection. Numeric columns are cast to `text` before returning to JavaScript to avoid Prisma's BigInt-as-string limitation.",
			annotation_position: "left",
		},
	});
	printResult("add_diff_step[7]", s7);

	// Step 8
	const s8 = await addDiffStepHandler(ctx, {
		step_index: 8,
		markdown: {
			content: "## LeafService: Breakdown Aggregation\n\n`getBreakdownsByOpportunity` composes the MV query with parallel opportunity and campaign fetches, then joins results in memory.",
		},
	});
	printResult("add_diff_step[8]", s8);

	// Step 9
	const s9 = await addDiffStepHandler(ctx, {
		step_index: 9,
		diff: {
			file_path: "apps/api/src/modules/v4/leaf/leaf.service.ts",
			patch: `+  static async getBreakdownsByOpportunity(recipient: string, distributionChainIds: number[]) {
+    if (distributionChainIds.length === 0) return [];
+    const sums = await LeafViewRepository.amountsByRecipientOpportunity(recipient, distributionChainIds);
+    if (sums.length === 0) return [];
+    const distinctOppIds = [...new Set(sums.map(s => s.opportunityId))];
+    const [campaigns, opportunities] = await Promise.all([
+      CampaignRepository.findLiveByOpportunityKeys(distributionChainIds, distinctOppIds),
+      OpportunityRepository.findLiveByIds(distinctOppIds),
+    ]);
+    const oppById = new Map(opportunities.map(o => [o.id, o]));
+    const campaignsByOppKey = new Map<string, CampaignShape[]>();
+    for (const c of campaigns) {
+      const key = \`\${c.distributionChainId}:\${c.opportunityId}\`;
+      ...
+    }
+    return sums
+      .filter(s => oppById.has(s.opportunityId))
+      .map(s => ({
+        ...s,
+        amount: s.amount.toString(),
+        claimed: s.claimed.toString(),
+        Opportunity: oppById.get(s.opportunityId)!,
+        Campaigns: campaignsByOppKey.get(\`\${s.distributionChainId}:\${s.opportunityId}\`) ?? [],
+      }));
+  }`,
			annotation: "The method fetches MV sums first, then fans out to opportunity and campaign queries in parallel. The campaign grouping key uses `distributionChainId:opportunityId` (colon separator) while the caller uses `\\0` — these are consistent within their respective scopes.",
			annotation_position: "right",
		},
	});
	printResult("add_diff_step[9]", s9);

	// Step 10
	const s10 = await addDiffStepHandler(ctx, {
		step_index: 10,
		markdown: {
			content: "## UserService: Core Aggregation Logic\n\n`getActiveOpportunities` is the largest addition (198 lines). It orchestrates the full pipeline: MV rows + temp leaves → per-opp aggregation → privacy masking → response shape.",
		},
	});
	printResult("add_diff_step[10]", s10);

	// Step 11
	const s11 = await addDiffStepHandler(ctx, {
		step_index: 11,
		diff: {
			file_path: "apps/api/src/modules/v4/user/user.service.ts",
			patch: `+  static async getActiveOpportunities(address, authOptions, withTestTokens) {
+    if (await BlacklistService.isBlacklisted(address)) return [];
+    const [chains, roots] = await Promise.all([ChainService.findAll(), MerklRootService.fetchAll()]);
+    const chainIds = chains.map(c => c.id).filter(id => roots[id]);
+    if (chainIds.length === 0) return [];
+    const [rows, tempLeaves] = await Promise.all([
+      LeafService.getBreakdownsByOpportunity(address, chainIds),
+      LeafTempRepository.getTempLeaves(address, chainIds),
+    ]);
+    if (rows.length === 0) return [];`,
			annotation: "The method short-circuits early on blacklist, no chains, and no MV rows. The early return after `rows.length === 0` means a user with only pending (temp) rewards and no settled rows will never see any opportunities — a known limitation called out in the JSDoc.",
			annotation_position: "left",
		},
	});
	printResult("add_diff_step[11]", s11);

	// Step 12
	const s12 = await addDiffStepHandler(ctx, {
		step_index: 12,
		markdown: {
			content: "## Pending Attribution and Second Pass\n\nTemp leaves are attributed to opportunities via a campaign→opp lookup built from the MV rows.",
		},
	});
	printResult("add_diff_step[12]", s12);

	// Step 13
	const s13 = await addDiffStepHandler(ctx, {
		step_index: 13,
		diff: {
			file_path: "apps/api/src/modules/v4/user/user.service.ts",
			patch: `+    const oppByCampaignKey = new Map<string, string>();
+    for (const row of rows) {
+      for (const c of row.Campaigns) {
+        oppByCampaignKey.set(\`\${row.distributionChainId}\\0\${c.campaignId}\`, row.opportunityId);
+      }
+    }
+    const pendingByOpp = new Map<string, Map<string, {...}>>();
+    for (const tl of tempLeaves) {
+      const oppId = oppByCampaignKey.get(\`\${tl.chainId}\\0\${tl.campaignId}\`);
+      if (!oppId) continue;
+      ...
+    }`,
			annotation: "Temp leaves are attributed to opportunities by looking up `(chainId, campaignId)` in a map derived from MV rows. Temp leaves for campaigns not represented in any MV row are silently dropped — deliberate, per the pending-only limitation.",
			annotation_position: "right",
		},
	});
	printResult("add_diff_step[13]", s13);

	// Step 14
	const s14 = await addDiffStepHandler(ctx, {
		step_index: 14,
		markdown: {
			content: "## Privacy Masking\n\nAfter aggregation, a single batched access check gates visibility. Denied opportunities are replaced with a per-chain private-opportunity placeholder.",
		},
	});
	printResult("add_diff_step[14]", s14);

	// Step 15
	const s15 = await addDiffStepHandler(ctx, {
		step_index: 15,
		diff: {
			file_path: "apps/api/src/modules/v4/user/user.service.ts",
			patch: `+    const evaluated = filtered.map(entry => ({
+      entry,
+      hasAccess: entry.campaigns.size > 0 && [...entry.campaigns.keys()].some(id => accessMap.get(id) === true),
+    }));
+    const privateChains = new Set<number>();
+    for (const { entry, hasAccess } of evaluated) if (!hasAccess) privateChains.add(entry.opportunity.chainId);
+    const privateByChain = new Map(
+      await Promise.all(
+        [...privateChains].map(async chainId => {
+          const raw = await OpportunityService.findOrCreatePrivateOpportunity(chainId);
+          return [chainId, OpportunityFormatter.formatWithoutRecords(raw)] as const;
+        }),
+      ),
+    );
+    return evaluated.map(({ entry, hasAccess }) => ({
+      opportunity: hasAccess ? entry.opportunity : privateByChain.get(entry.opportunity.chainId)!,
+      earnedTokens: [...entry.earnedTokens.values()].map(et => ({
+        token: TokenFormatter.format(et.token),
+        amount: (et.amount + et.pending).toString(),
+        chain: ChainFormatter.format(et.chain),
+      })),
+    }));
+  }`,
			annotation: "Privacy-denied opportunities are replaced with the chain's private-opp placeholder. The deduplication by chain (`privateChains` Set) ensures at most one DB lookup per chain regardless of how many denied opps share it. The `!` non-null assertion on `privateByChain.get(...)` is safe because the key was added in the same scope.",
			annotation_position: "left",
		},
	});
	printResult("add_diff_step[15]", s15);

	// flag_issue after step 15
	const fi2 = await flagIssueHandler(ctx, {
		severity: "warning",
		title: "Private-opp amount still surfaced when access is denied",
		description: "earnedTokens amounts are emitted even for privacy-masked opportunities",
		block_orders: [15],
		file_path: "apps/api/src/modules/v4/user/user.service.ts",
		start_line: 620,
		end_line: 628,
	});
	printResult("flag_issue[2]", fi2);

	const fi2Text = fi2.content[0]?.text ?? "";
	const fi2IdMatch = /id: ([a-f0-9]+)/.exec(fi2Text);
	const fi2Id = fi2IdMatch?.[1] ?? "";
	console.log(`Issue 2 ID: ${fi2Id}`);

	// add_issue_comment for issue 2
	const ic2 = await addIssueCommentHandler(ctx, {
		issue_id: fi2Id,
		file_path: "apps/api/src/modules/v4/user/user.service.ts",
		start_line: 620,
		end_line: 628,
		diff_side: "right",
		body: "When an opportunity is privacy-masked, the response replaces the `opportunity` object with the generic private-opp placeholder — but it still emits the user's real `earnedTokens` amounts. A caller who knows the token address can infer which private opportunity this is. Consider whether `earnedTokens` should also be masked (e.g., returning an empty array or zeroed amounts) for denied opportunities, to be consistent with the privacy model used elsewhere in the API.",
	});
	printResult("add_issue_comment[2]", ic2);

	// Step 16
	const s16 = await addDiffStepHandler(ctx, {
		step_index: 16,
		markdown: {
			content: "## New Controller Endpoint and DTO\n\nThe endpoint is wired into the user router with a no-cache header and response validation.",
		},
	});
	printResult("add_diff_step[16]", s16);

	// Step 17
	const s17 = await addDiffStepHandler(ctx, {
		step_index: 17,
		diff: {
			file_path: "apps/api/src/modules/v4/user/user.controller.ts",
			patch: `+  .get(
+    "/:address/rewards/active-opportunities",
+    async ({ params, query, userAddress, isBackOffice }) =>
+      UserService.getActiveOpportunities(params.address, { userAddress, isBackOffice }, !!query.test),
+    {
+      params: UserUniqueDto,
+      query: ActiveOpportunitiesQueryDto,
+      beforeHandle: ({ params, set, cookie, headers }) => {
+        setCacheHeaders(0)({ set, cookie, headers });
+        params.address = throwOnInvalidRequiredAddress(params.address);
+      },
+      response: UserActiveOpportunitiesResourceDto,
+      detail: { description: "..." },
+    },
+  )`,
			annotation: "Cache is set to 0 (no-cache), consistent with other user-reward endpoints. Address validation is delegated to `throwOnInvalidRequiredAddress`. The `response` validator provides Elysia's type-narrowing guarantee.",
			annotation_position: "right",
		},
	});
	printResult("add_diff_step[17]", s17);

	// Step 18
	const s18 = await addDiffStepHandler(ctx, {
		step_index: 18,
		markdown: {
			content: "## Test Coverage\n\nThe new test file provides good unit-level coverage using Bun's spyOn to mock all external dependencies.",
		},
	});
	printResult("add_diff_step[18]", s18);

	// Step 19
	const s19 = await addDiffStepHandler(ctx, {
		step_index: 19,
		diff: {
			file_path: "apps/api/tests/v4/user/user.service.test.ts",
			patch: `+  it("drops opps where amount === claimed and there is no pending", ...);
+  it("keeps opps with pending > 0 even when settled is fully claimed", ...);
+  it("dedupes findOrCreatePrivateOpportunity by chain across multiple denied entries", ...);
+  it("drops temp leaves whose campaign is not linked to any MV-row opportunity", ...);
+  it("materializes a fresh earnedToken entry when pending targets a (chain, token) absent from MV rows", ...);`,
			annotation: "Tests cover the main branches: blacklist, no-roots, owed-filter, token-type filtering, APR sort, privacy masking, and pending attribution edge cases. The dedup test verifies the `findOrCreatePrivateOpportunity` batching behaviour.",
			annotation_position: "left",
		},
	});
	printResult("add_diff_step[19]", s19);

	// flag_issue after step 19
	const fi3 = await flagIssueHandler(ctx, {
		severity: "info",
		title: "No test for pending-only user (no MV rows)",
		description: "The known limitation (pending-only opps not surfaced) is documented but not tested",
		block_orders: [19],
		file_path: "apps/api/tests/v4/user/user.service.test.ts",
		start_line: 1,
		end_line: 363,
	});
	printResult("flag_issue[3]", fi3);

	// Phase C: set_sentiment
	console.log("\n=== Phase C: set_sentiment ===");
	const sentiment = await setSentimentHandler(ctx, {
		markdown: "This PR is well-structured and ready to merge with one design question to resolve. The core logic is sound: MV-backed aggregation, parallel fetches, SQL-level LIVE filtering, and privacy masking are all implemented correctly. The cartesian cross-filter in `findLiveByOpportunityKeys` is semantically imprecise but practically harmless today. The more substantive question is whether `earnedTokens` amounts should be masked alongside the opportunity object for privacy-denied entries — if the privacy model elsewhere omits amounts, this endpoint is inconsistent and should be aligned before shipping.",
	});
	printResult("set_sentiment", sentiment);

	// Phase D: rate_axis (9 axes)
	console.log("\n=== Phase D: rate_axis ===");

	const r1 = await rateAxisHandler(ctx, {
		axis: "correctness",
		verdict: "pass",
		confidence: "medium",
		rationale: "Logic handles the MV→temp-leaf join, bigint conversions, and the pending-only drop correctly. The cartesian filter is semantically imprecise but produces no incorrect output given the subsequent per-row join.",
		citations: [],
		block_orders: [],
	});
	printResult("rate_axis[correctness]", r1);

	const r2 = await rateAxisHandler(ctx, {
		axis: "scope",
		verdict: "pass",
		confidence: "high",
		rationale: "PR is tightly scoped: one new endpoint, the MV refresh registration, lean repository helpers, and their tests. No drive-by refactors.",
		citations: [],
		block_orders: [],
	});
	printResult("rate_axis[scope]", r2);

	const r3 = await rateAxisHandler(ctx, {
		axis: "tests",
		verdict: "concern",
		confidence: "high",
		rationale: "12 unit tests cover the main branches well, but the known pending-only limitation is undocumented by a test, and there are no integration tests verifying the MV query or the SQL cross-filter behaviour.",
		citations: [{ file_path: "apps/api/tests/v4/user/user.service.test.ts", start_line: 1, end_line: 363, note: null }],
		block_orders: [],
	});
	printResult("rate_axis[tests]", r3);

	const r4 = await rateAxisHandler(ctx, {
		axis: "clarity",
		verdict: "pass",
		confidence: "high",
		rationale: "Code is well-commented with JSDoc, inline explanations of the `\\0` separator convention, and the pending-only limitation is explicitly called out.",
		citations: [],
		block_orders: [],
	});
	printResult("rate_axis[clarity]", r4);

	const r5 = await rateAxisHandler(ctx, {
		axis: "safety",
		verdict: "concern",
		confidence: "medium",
		rationale: "Privacy masking replaces `opportunity` but still emits real `earnedTokens` amounts for denied entries — potential information leak depending on the privacy contract.",
		citations: [{ file_path: "apps/api/src/modules/v4/user/user.service.ts", start_line: 620, end_line: 628, note: null }],
		block_orders: [],
	});
	printResult("rate_axis[safety]", r5);

	const r6 = await rateAxisHandler(ctx, {
		axis: "consistency",
		verdict: "pass",
		confidence: "high",
		rationale: "Follows existing patterns: `$executeRawUnsafe` for MV refreshes, `safeBigInt` for numeric columns, `formatWithoutRecords` for opportunity DTOs, `CampaignService.checkAccessBatch` for privacy.",
		citations: [],
		block_orders: [],
	});
	printResult("rate_axis[consistency]", r6);

	const r7 = await rateAxisHandler(ctx, {
		axis: "api_changes",
		verdict: "pass",
		confidence: "high",
		rationale: "New endpoint only; no existing routes or response schemas modified. The Elysia `response` validator enforces the DTO shape.",
		citations: [],
		block_orders: [],
	});
	printResult("rate_axis[api_changes]", r7);

	const r8 = await rateAxisHandler(ctx, {
		axis: "performance",
		verdict: "pass",
		confidence: "medium",
		rationale: "MV query + two parallel DB fetches is a reasonable N=3 round-trip. Token lookup is a single batch. No N+1 loops.",
		citations: [],
		block_orders: [],
	});
	printResult("rate_axis[performance]", r8);

	const r9 = await rateAxisHandler(ctx, {
		axis: "description",
		verdict: "concern",
		confidence: "high",
		rationale: "The PR description is not included in this diff — if the PR description is empty or terse, reviewers have no context on the MV DDL, staleness contract, or the pending-only limitation.",
		citations: [{ file_path: "apps/api/src/modules/v4/user/user.controller.ts", start_line: 190, end_line: 212, note: null }],
		block_orders: [],
	});
	printResult("rate_axis[description]", r9);

	// complete_walkthrough
	console.log("\n=== Final: complete_walkthrough ===");
	const done = await completeWalkthroughHandler(ctx, {});
	printResult("complete_walkthrough", done);

	console.log("\n✅ Pipeline complete!");
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
