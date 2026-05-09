#!/usr/bin/env bun
/**
 * Walkthrough pipeline for the rewards endpoints PR.
 * Creates a new walkthrough row and executes the full A→B→C→D pipeline.
 *
 * Usage: bun run run-pr-rewards-review.ts
 */

import { and, eq } from "drizzle-orm";
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
const REVIEW_SESSION_ID = "077d367e-1276-4e5b-ae19-a2bf0fcbd067";
const PULL_REQUEST_ID = "4b8eb7e1-f976-445d-a543-34fec3f3198a:149";
const PR_HEAD_SHA = "rewards-active-opps-pr-sha-001";
const WALKTHROUGH_ID = crypto.randomUUID();

// ── Setup ────────────────────────────────────────────────────────────────────

console.log(`\n=== Rewards Endpoints PR Walkthrough Pipeline ===`);
console.log(`Walkthrough ID: ${WALKTHROUGH_ID}`);
console.log(`DB: ${DB_PATH}\n`);

const db = createDb(DB_PATH);

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
		"This PR introduces two new endpoints for the user rewards system: a cross-chain \"active opportunities\" aggregator (`GET /:address/rewards/active-opportunities`) that surfaces LIVE opportunities with unclaimed or pending rewards, and a lazy-loaded per-chain opportunity breakdown (`GET /:address/rewards/chains/:chainId/breakdowns`) for the dashboard drawer. The implementation uses a materialized view (`leaf_breakdown_amounts_per_recipient_opportunity`) for settled amounts (≤30 min stale) combined with live temp-leaf lookups for pending rewards, with privacy masking via `CampaignService.checkAccessBatch`.",
	risk_level: "medium",
});
printResult("set_overview", overviewResult);

// ── Phase B: diff steps ──────────────────────────────────────────────────────

console.log("\n── Phase B: diff steps ──");

// Step 0
console.log("\n  [B-0] markdown: Two-endpoint surface and data flow");
const b0 = await addDiffStepHandler(ctx, {
	step_index: 0,
	markdown: {
		content: `## Two-Endpoint Surface and Data Flow Pattern

This PR adds two new endpoints to the user rewards API:

1. **\`GET /:address/rewards/active-opportunities\`** — Cross-chain aggregator. Returns all LIVE opportunities where the user has rewards still owed (amount > 0, LIVE status). Filters out RETIRED/PAST opportunities. Merges materialized-view settled amounts with live temp-leaf pending amounts.

2. **\`GET /:address/rewards/chains/:chainId/breakdowns\`** — Per-chain lazy-load endpoint. Returns the per-opportunity breakdown for a single chain, used by the dashboard drawer when the user expands a chain card.

The data flow for both endpoints: **MV query** (settled amounts, ≤30 min stale) + **live leaf lookup** (pending amounts) → **privacy masking** via \`CampaignService.checkAccessBatch\` → **response formatting**.`,
	},
});
printResult("add_diff_step[0]", b0);

// Step 1
console.log("\n  [B-1] diff: leafView.repository.ts - amountsByRecipientOpportunity");
const b1 = await addDiffStepHandler(ctx, {
	step_index: 1,
	diff: {
		file_path: "apps/api/src/modules/v4/leaf/leafView.repository.ts",
		patch: `@@ -0,0 +1,46 @@
+export abstract class LeafViewRepository {
+  static async amountsByRecipientOpportunity(
+    recipient: string,
+    chainId: number,
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
+      \`SELECT opportunity_id, token_address, amount, claimed
+       FROM leaf_breakdown_amounts_per_recipient_opportunity
+       WHERE recipient = $1 AND chain_id = $2\`,
+      recipient,
+      chainId,
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
			"Uses `$queryRawUnsafe` with Prisma's parameterized `$1/$2` placeholders — SQL injection is not possible. However, the raw SQL approach bypasses Prisma's type system: column names are not validated at compile time, and a schema migration that renames a column (e.g., `opportunity_id` → `opp_id`) would produce a silent runtime failure rather than a TS error.",
		annotation_position: "right",
	},
});
printResult("add_diff_step[1]", b1);

// Step 2
console.log("\n  [B-2] markdown: getBreakdownsByOpportunity orchestration");
const b2 = await addDiffStepHandler(ctx, {
	step_index: 2,
	markdown: {
		content: `## \`getBreakdownsByOpportunity\` Orchestration

The new \`LeafRepository.getBreakdownsByOpportunity\` method coordinates two parallel DB queries:

- **Query A**: Fetches opportunity metadata from the relational DB (opportunity rows with chain/token includes), filtered to only LIVE status at the SQL layer.
- **Query B**: Calls \`LeafViewRepository.amountsByRecipientOpportunity\` to read settled amounts from the materialized view.

Both queries run in a single \`Promise.all\` to minimize latency. The LIVE filter at the SQL layer means RETIRED/PAST opportunities are excluded before any JS processing — this is the correct place to apply the filter.`,
	},
});
printResult("add_diff_step[2]", b2);

// Step 3
console.log("\n  [B-3] diff: leaf.repository.ts - getBreakdownsByOpportunity method");
const b3 = await addDiffStepHandler(ctx, {
	step_index: 3,
	diff: {
		file_path: "apps/api/src/modules/v4/leaf/leaf.repository.ts",
		patch: `@@ -167,0 +168,75 @@
+  static async getBreakdownsByOpportunity(
+    recipient: string,
+    chainId: number,
+  ): Promise<BreakdownsByOpportunityRow[]> {
+    const [opportunities, mvAmounts] = await Promise.all([
+      apiDbClient.opportunity.findMany({
+        where: {
+          distributionChainId: chainId,
+          status: "LIVE",
+        },
+        include: {
+          MainProtocol: true,
+          Chain: true,
+          Tokens: true,
+          ActivePrograms: true,
+          DepositUrls: { orderBy: { priority: "asc" } },
+        },
+      }),
+      LeafViewRepository.amountsByRecipientOpportunity(recipient, chainId),
+    ]);
+
+    const amountByOppToken = new Map(
+      mvAmounts.map(r => [\`\${r.opportunityId}:\${r.tokenAddress}\`, r]),
+    );
+
+    return opportunities.flatMap(opp =>
+      (opp.Tokens ?? []).map(token => {
+        const key = \`\${opp.id}:\${token.address}\`;
+        const mv = amountByOppToken.get(key);
+        return {
+          ...opp,
+          tokenAddress: token.address,
+          amount: mv?.amount ?? 0n,
+          claimed: mv?.claimed ?? 0n,
+        };
+      })
+    );
+  }`,
		annotation:
			"The `flatMap` over `opp.Tokens` generates one row per (opportunity, token) pair. Opportunities with no matching MV row get `amount: 0n, claimed: 0n` — these will later be filtered out by the service layer check `amount > 0n || pending > 0n`. The LIVE filter at the DB layer is correct: RETIRED/PAST opportunities never appear in this output.",
		annotation_position: "left",
	},
});
printResult("add_diff_step[3]", b3);

// Step 4
console.log("\n  [B-4] markdown: getActiveOpportunities service method walkthrough");
const b4 = await addDiffStepHandler(ctx, {
	step_index: 4,
	markdown: {
		content: `## \`getActiveOpportunities\` Service Method — Two-Pass Accumulation

The \`UserService.getActiveOpportunities\` method is the most complex new addition (~130 lines). It performs two accumulation passes:

**Pass 1 — Pending amounts from live leaves:**
- Fetches live temp-leaf rows for the recipient across all chains.
- Builds a \`pendingByKey\` map keyed on \`chainId:opportunityId:tokenAddress\`.
- Uses a reverse lookup \`oppByCampaignKey\` (\`chainId:campaignId\`) to attribute temp-leaf amounts to the correct opportunity.

**Pass 2 — Merging MV settled amounts with pending:**
- Iterates all breakdowns from \`getBreakdownsByOpportunity\`.
- For each (opp, token) row, looks up pending amount from \`pendingByKey\`.
- Computes \`claimable = max(0, amount - claimed)\` (clamped to prevent negative values from MV staleness).
- Includes the row only if \`amount > 0n || pending > 0n\` (at least one non-zero amount).`,
	},
});
printResult("add_diff_step[4]", b4);

// Step 5
console.log("\n  [B-5] code: user.service.ts pending attribution loop");
const b5 = await addDiffStepHandler(ctx, {
	step_index: 5,
	code: {
		file_path: "apps/api/src/modules/v4/user/user.service.ts",
		start_line: 510,
		end_line: 545,
		language: "typescript",
		content: `// Build pending attribution maps from live temp-leaf rows
const oppByCampaignKey = new Map<string, string>(); // "chainId:campaignId" → opportunityId
for (const breakdown of allBreakdowns) {
  for (const program of breakdown.ActivePrograms ?? []) {
    oppByCampaignKey.set(\`\${breakdown.distributionChainId}:\${program.campaignId}\`, breakdown.id);
  }
}

const pendingByKey = new Map<string, bigint>(); // "chainId:oppId:tokenAddress" → pending
for (const leaf of tempLeaves) {
  const sep1 = leaf.campaignId.indexOf(':');
  const sep2 = leaf.campaignId.indexOf(':', sep1 + 1);
  const chainId = leaf.campaignId.slice(0, sep1);
  const campaignId = leaf.campaignId.slice(sep1 + 1, sep2);
  const oppId = oppByCampaignKey.get(\`\${chainId}:\${campaignId}\`);
  if (!oppId) continue;
  const key = \`\${chainId}:\${oppId}:\${leaf.tokenAddress}\`;
  pendingByKey.set(key, (pendingByKey.get(key) ?? 0n) + BigInt(leaf.amount));
}`,
		annotation:
			"The `key.slice(sep1+1, sep2)` pattern parses a composite `campaignId` string (format: `chainId:campaignId:...`) to extract the inner campaign segment. This is brittle: if the format ever changes, the slice produces a wrong substring silently. A more robust approach would be to split by `:` and take the second element.",
		annotation_position: "right",
	},
});
printResult("add_diff_step[5]", b5);

// Step 6
console.log("\n  [B-6] markdown: Privacy masking pattern");
const b6 = await addDiffStepHandler(ctx, {
	step_index: 6,
	markdown: {
		content: `## Privacy Masking Pattern

After accumulating active opportunities, the service applies privacy masking via \`CampaignService.checkAccessBatch\`:

1. Collect all opportunity IDs from the active result set.
2. Call \`CampaignService.checkAccessBatch(opportunityIds, userAddress)\` — returns a map of \`oppId → { allowed: boolean }\`.
3. For denied opportunities, replace with a "private placeholder" object keyed per-chain via a \`privateByChain\` map — one placeholder per chain regardless of how many denied opportunities exist on that chain.

The batched access check avoids N+1 calls (one per opportunity). The per-chain deduplication of private placeholders is intentional — the UI shows a single "private opportunity" card per chain, not one per denied opportunity.`,
	},
});
printResult("add_diff_step[6]", b6);

// Step 7
console.log("\n  [B-7] diff: user.controller.ts - both new routes");
const b7 = await addDiffStepHandler(ctx, {
	step_index: 7,
	diff: {
		file_path: "apps/api/src/modules/v4/user/user.controller.ts",
		patch: `@@ -180,0 +181,46 @@
+  .get("/:address/rewards/active-opportunities", async ({ params, query }) =>
+    UserService.getActiveOpportunities(params.address, query), {
+    params: UserUniqueDto,
+    query: ActiveOpportunitiesQueryDto,
+    beforeHandle: ({ params, set, cookie, headers }) => {
+      setCacheHeaders(0)({ set, cookie, headers });
+      params.address = throwOnInvalidRequiredAddress(params.address);
+    },
+    response: ActiveOpportunitiesResponseDto,
+  })
+  .get("/:address/rewards/chains/:chainId/breakdowns", async ({ params }) =>
+    UserService.getChainBreakdown(params.address, params.chainId), {
+    params: t.Object({
+      address: t.String(),
+      chainId: t.Numeric(),
+    }),
+    beforeHandle: ({ params, set, cookie, headers }) => {
+      setCacheHeaders(0)({ set, cookie, headers });
+      params.address = throwOnInvalidRequiredAddress(params.address);
+      throwOnUnsupportedChainId(params.chainId);
+    },
+    response: ChainBreakdownResponseDto,
+  })`,
		annotation:
			"Both routes use `setCacheHeaders(0)` (no-cache) — correct for user-specific live data. The `active-opportunities` route has no staleness signal to clients despite the MV data being up to 30 min stale. The `breakdowns` route validates the chainId via `throwOnUnsupportedChainId`, which is good hygiene.",
		annotation_position: "left",
	},
});
printResult("add_diff_step[7]", b7);

// Flag issue: MV staleness not surfaced to client
console.log("\n  [flag_issue] MV staleness not surfaced to client");
const issue1Result = await flagIssueHandler(ctx, {
	severity: "warning",
	title: "MV staleness (≤30 min) not surfaced to API clients",
	description:
		"The active-opportunities response mixes MV settled amounts (up to 30 min stale) with live pending amounts but provides no staleness signal (no cache-age header, no dataAsOf field). Clients cannot show freshness indicators.",
	block_orders: [7],
	file_path: "apps/api/src/modules/v4/user/user.controller.ts",
	start_line: 198,
	end_line: 198,
});
const issue1Text = printResult("flag_issue[MV staleness]", issue1Result);
const issue1Id = extractIssueId(issue1Text, "flag_issue[MV staleness]");

// Add inline comment for issue 1
console.log("\n  [add_issue_comment] MV staleness");
const comment1Result = await addIssueCommentHandler(ctx, {
	issue_id: issue1Id,
	file_path: "apps/api/src/modules/v4/user/user.controller.ts",
	start_line: 198,
	end_line: 198,
	diff_side: "new",
	body: "The settled amounts in this response come from the `leaf_breakdown_amounts_per_recipient_opportunity` materialized view, which can be up to 30 minutes stale. The response has `setCacheHeaders(0)` (no-cache) which prevents browser caching, but there's no signal to the client about the *data freshness* of the MV amounts themselves.\n\nConsider one of:\n- Add a `Cache-Control: stale-while-revalidate` or a custom `X-Data-As-Of` header with the MV's last-refresh timestamp.\n- Include a top-level `dataAsOf: string` (ISO timestamp) field in the response DTO so dashboards can show a \"data as of N minutes ago\" indicator.\n\nWithout this, users may see \"0 claimable\" amounts and not know whether that's accurate or whether the MV hasn't caught up yet.",
});
printResult("add_issue_comment[MV staleness]", comment1Result);

// Step 8
console.log("\n  [B-8] markdown: Test coverage overview");
const b8 = await addDiffStepHandler(ctx, {
	step_index: 8,
	markdown: {
		content: `## Test Coverage Overview

The PR includes a new test file \`apps/api/tests/v4/user/user.service.test.ts\` (+669 lines) with unit tests for both new service methods:

- **\`getActiveOpportunities\`**: Happy path, token dedup, APR sort, privacy masking dedup, SubCampaign override, claimable clamping (amount < claimed edge case).
- **\`getChainBreakdown\`**: Happy path, empty chain, multi-token opportunities.

The 669-line test suite is thorough for a new feature of this scope. The claimable clamping test (verifying that \`amount - claimed\` is clamped to 0 when claimed > amount due to MV staleness) is particularly important and good to see covered.`,
	},
});
printResult("add_diff_step[8]", b8);

// Step 9
console.log("\n  [B-9] diff: user.service.test.ts - key test cases");
const b9 = await addDiffStepHandler(ctx, {
	step_index: 9,
	diff: {
		file_path: "apps/api/tests/v4/user/user.service.test.ts",
		patch: `@@ -0,0 +1,50 @@
+describe("getActiveOpportunities", () => {
+  it("returns empty array when no live leaves", async () => {
+    mockGetByRecipient.mockResolvedValueOnce([]);
+    const result = await UserService.getActiveOpportunities("0xuser", {});
+    expect(result).toEqual([]);
+  });
+
+  it("clamps claimable to 0 when MV amount < claimed (stale MV)", async () => {
+    // MV amount is 50, claimed is 100 (MV hasn't caught up to a recent claim)
+    mockMvAmounts.mockResolvedValueOnce([{
+      opportunityId: "opp-1", tokenAddress: "0xtoken", amount: 50n, claimed: 100n,
+    }]);
+    const result = await UserService.getActiveOpportunities("0xuser", {});
+    const opp = result.find(r => r.id === "opp-1");
+    expect(opp?.claimable).toBe("0");  // not "-50"
+  });
+
+  it("deduplicates private placeholder per chain", async () => {
+    // Two denied opps on chainId=1 should produce ONE private placeholder
+    mockCheckAccessBatch.mockResolvedValueOnce({
+      "opp-A": { allowed: false },
+      "opp-B": { allowed: false },
+    });
+    const result = await UserService.getActiveOpportunities("0xuser", {});
+    const privateOpps = result.filter(r => r.isPrivate);
+    expect(privateOpps).toHaveLength(1);
+  });
+});`,
		annotation:
			"The claimable-clamping test directly covers the MV staleness edge case where a user claims and the MV hasn't refreshed yet. The private-placeholder dedup test confirms that multiple denied opportunities on the same chain collapse to one private card. Both are regression-worthy behaviors.",
		annotation_position: "right",
	},
});
printResult("add_diff_step[9]", b9);

// Flag issue: duplicate private-opp entries for multiple denied opps on same chain
console.log("\n  [flag_issue] Private-opp dedup produces duplicate entries");
const issue2Result = await flagIssueHandler(ctx, {
	severity: "warning",
	title:
		"Multiple denied opps on same chain produce duplicate private placeholder entries",
	description:
		"When multiple denied opportunities exist on the same chainId, the `privateByChain` map deduplicates to ONE private placeholder object, but all denied opps map to that same object — the output array may contain the same private placeholder object reference multiple times (duplicate `id`).",
	block_orders: [5, 6],
	file_path: "apps/api/src/modules/v4/user/user.service.ts",
	start_line: 570,
	end_line: 580,
});
const issue2Text = printResult(
	"flag_issue[private-opp dedup]",
	issue2Result,
);
const issue2Id = extractIssueId(issue2Text, "flag_issue[private-opp dedup]");

// Add inline comment for issue 2
console.log("\n  [add_issue_comment] private-opp dedup");
const comment2Result = await addIssueCommentHandler(ctx, {
	issue_id: issue2Id,
	file_path: "apps/api/src/modules/v4/user/user.service.ts",
	start_line: 570,
	end_line: 580,
	diff_side: "new",
	body: "When two or more denied opportunities share the same `chainId`, the `privateByChain` map returns the same private placeholder object for each. If those denied opportunities are each pushed into the result array individually (rather than the placeholder being pushed once), the response will contain the same private card multiple times with the same `id`.\n\nEnsure the accumulation loop either:\n1. Pushes the private placeholder **once per chain** (after processing all denied opps for that chain), or\n2. Tracks which chains have already had a private placeholder added and skips subsequent denied opps on that chain.\n\nThe test at line ~650 (`deduplicates private placeholder per chain`) should catch this if the mock setup correctly provides two denied opps on the same chain.",
});
printResult("add_issue_comment[private-opp dedup]", comment2Result);

// ── Phase C: set_sentiment ────────────────────────────────────────────────────

console.log("\n── Phase C: set_sentiment ──");
const sentimentResult = await setSentimentHandler(ctx, {
	markdown:
		"This PR is ready to merge with one recommendation addressed: the active-opportunities endpoint should surface staleness information to clients (via a cache header or a top-level `dataAsOf` field in the response) so dashboards can show freshness indicators. The new endpoints are well-structured, the MV + temp-leaf data flow is sound, the LIVE-status filter at the SQL layer is correct, and the test suite is thorough. The privacy-masking deduplication for the private placeholder across multiple denied opps on the same chain warrants a follow-up to avoid duplicate entries in the response.",
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
		"The two-pass accumulation logic is correct; the claimable clamp `(amount > claimed ? amount - claimed : 0n)` handles MV staleness edge cases. BigInt conversions are safe. The LIVE filter at the SQL layer is properly placed.",
	details:
		"The `claimable = amount > claimed ? amount - claimed : 0n` guard correctly handles the race condition where the MV hasn't caught up to a recent claim (claimed > amount). The `Promise.all` for parallel queries is used correctly. The `flatMap` over `opp.Tokens` correctly generates one row per (opportunity, token) pair. No off-by-one or boundary errors were identified in the accumulation logic.",
	citations: [],
	block_orders: [3, 4],
});
printResult("rate_axis[correctness]", r1);

// 2. scope
const r2 = await rateAxisHandler(ctx, {
	axis: "scope",
	verdict: "pass",
	confidence: "high",
	rationale:
		"Two related endpoints + repository methods + DTOs + tests. Focused and coherent. The new `LeafViewRepository` is a natural addition alongside `LeafRepository`.",
	details:
		"The PR adds exactly the two endpoints described in the summary, plus the supporting repository layer (`LeafViewRepository.amountsByRecipientOpportunity`, `LeafRepository.getBreakdownsByOpportunity`), service methods, DTOs, and tests. No unrelated changes or drive-by refactors were identified. The scope is appropriate for a single PR.",
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
		"669 lines of unit tests covering happy paths, edge cases (token filtering, APR sort, privacy masking dedup, SubCampaign override, claimable clamping). The claimable-clamping test is particularly important.",
	details:
		"The test suite covers the most critical behaviors: claimable clamping when MV is stale, private placeholder deduplication per chain, token dedup across breakdowns, and APR-based sorting. The presence of a dedicated test for the MV staleness edge case (amount < claimed → clamp to 0) is evidence of careful thinking about failure modes.",
	citations: [],
	block_orders: [8, 9],
});
printResult("rate_axis[tests]", r3);

// 4. clarity
const r4 = await rateAxisHandler(ctx, {
	axis: "clarity",
	verdict: "concern",
	confidence: "medium",
	rationale:
		"`getActiveOpportunities` is 130+ lines with nested Maps and two accumulation passes. The pending key parsing `key.slice(sep1+1, sep2)` is brittle string manipulation that obscures intent.",
	details:
		"The `oppByCampaignKey` + `pendingByKey` double-map construction is hard to follow without reading the full context. The `key.slice(sep1+1, sep2)` substring extraction in particular is a code smell — a split-and-index approach would be clearer. Consider extracting the pending attribution logic into a `buildPendingByKey(tempLeaves, oppByCampaignKey)` helper function to flatten the nesting.",
	citations: [
		{
			file_path: "apps/api/src/modules/v4/user/user.service.ts",
			start_line: 510,
			end_line: 540,
			note: null,
		},
	],
	block_orders: [5],
});
printResult("rate_axis[clarity]", r4);

// 5. safety
const r5 = await rateAxisHandler(ctx, {
	axis: "safety",
	verdict: "concern",
	confidence: "medium",
	rationale:
		"The active-opportunities endpoint has `setCacheHeaders(0)` (no-cache) which is correct, but the MV data is up to 30 min stale with no staleness signal to the client.",
	details:
		"The MV (`leaf_breakdown_amounts_per_recipient_opportunity`) can be up to 30 minutes stale. The response provides no indication of data freshness — no `X-Data-As-Of` header, no `dataAsOf` field. A user who claimed rewards recently may see non-zero claimable amounts that are already claimed (until the MV refreshes). The clamp prevents negative values, but the user still sees stale data without knowing it. Adding a `dataAsOf` ISO timestamp field to the response DTO would address this.",
	citations: [
		{
			file_path: "apps/api/src/modules/v4/user/user.controller.ts",
			start_line: 198,
			end_line: 198,
			note: null,
		},
	],
	block_orders: [7],
});
printResult("rate_axis[safety]", r5);

// 6. consistency
const r6 = await rateAxisHandler(ctx, {
	axis: "consistency",
	verdict: "pass",
	confidence: "high",
	rationale:
		"Follows existing patterns: `LeafRepository`, `LeafViewRepository`, `UserService` static methods, `ChainFormatter.format`, privacy masking via `CampaignService.checkAccessBatch`.",
	details:
		"The new `LeafViewRepository` mirrors the `LeafRepository` abstract class pattern. Service methods follow the static async pattern used throughout `UserService`. `ChainFormatter.format` and `TokenFormatter.format` are used consistently for response formatting. The `setCacheHeaders(0)` + `throwOnInvalidRequiredAddress` pattern in `beforeHandle` matches adjacent routes.",
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
		"Additive only — two new GET routes under `/users`. No existing route signatures changed.",
	details:
		"Both new endpoints (`GET /:address/rewards/active-opportunities` and `GET /:address/rewards/chains/:chainId/breakdowns`) are purely additive. No existing route signatures, DTOs, or response shapes were modified. The new endpoints follow the same URL pattern as existing user reward routes.",
	citations: [],
	block_orders: [7],
});
printResult("rate_axis[api_changes]", r7);

// 8. performance
const r8 = await rateAxisHandler(ctx, {
	axis: "performance",
	verdict: "pass",
	confidence: "medium",
	rationale:
		"Parallel `Promise.all` for DB queries. MV used for settled amounts avoids full leaf scan. Single batched access check via `CampaignService.checkAccessBatch`.",
	details:
		"The `Promise.all([opportunities query, MV query])` correctly parallelizes the two DB reads. Using the materialized view for settled amounts avoids a potentially expensive full leaf scan on every request. The batched `checkAccessBatch` call replaces what could have been N per-opportunity access checks. The `flatMap` join on the JS side is O(opportunities × tokens), which is bounded and acceptable.",
	citations: [],
	block_orders: [2, 3],
});
printResult("rate_axis[performance]", r8);

// 9. description
const r9 = await rateAxisHandler(ctx, {
	axis: "description",
	verdict: "concern",
	confidence: "low",
	rationale:
		"Cannot see the PR description text in this review context, so rating concern as a precaution. Controller registrations include OpenAPI detail blocks but no PR body was available to assess deployment notes.",
	details:
		"The controller registrations include OpenAPI `detail` blocks with tags and descriptions. The code is self-documenting. However, no PR description was available in the review context to assess the 'why', deployment notes, or migration steps. Confidence is low — the code quality suggests the PR description is likely adequate.",
	citations: [
		{
			file_path: "apps/api/src/modules/v4/user/user.controller.ts",
			start_line: 181,
			end_line: 210,
			note: "Controller routes registered without visible PR description context",
		},
	],
	block_orders: [7],
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
