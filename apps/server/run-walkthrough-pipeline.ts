#!/usr/bin/env bun
/**
 * Direct in-process walkthrough pipeline executor.
 * Resets an error/superseded walkthrough and executes the full A→B→C→D pipeline.
 *
 * Usage: bun run run-walkthrough-pipeline.ts <walkthrough-id>
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

const WALKTHROUGH_ID = process.argv[2] ?? "e6af2eb6-8e73-4676-a94c-9702b63d9b3a";
const DB_PATH = "./revv-dev.db";

// ── Setup ────────────────────────────────────────────────────────────────────

console.log(`\n=== Walkthrough Pipeline Executor ===`);
console.log(`Walkthrough ID: ${WALKTHROUGH_ID}`);
console.log(`DB: ${DB_PATH}\n`);

const db = createDb(DB_PATH);

// Reset the walkthrough to generating/none so we can re-run the pipeline
console.log("Resetting walkthrough to generating/none...");
db.update(walkthroughs)
	.set({ status: "generating", lastCompletedPhase: "none", summary: "", sentiment: null })
	.where(eq(walkthroughs.id, WALKTHROUGH_ID))
	.run();

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

function printResult(name: string, result: { content: Array<{ text: string }>; isError?: boolean }) {
	const text = result.content[0]?.text ?? "(no content)";
	const status = result.isError ? "❌ ERROR" : "✅ OK";
	console.log(`\n[${name}] ${status}`);
	if (result.isError || text.length < 300) {
		console.log(`  ${text}`);
	} else {
		console.log(`  ${text.slice(0, 200)}...`);
	}
	if (result.isError) {
		console.error(`FATAL: ${name} failed. Aborting.`);
		process.exit(1);
	}
	return text;
}

// ── Step 0: get_walkthrough_state ─────────────────────────────────────────────

console.log("\n── Step 0: get_walkthrough_state ──");
const stateResult = await getWalkthroughStateHandler(ctx, { walkthrough_id: WALKTHROUGH_ID });
const stateText = printResult("get_walkthrough_state", stateResult);
console.log("\nFull state response:");
console.log(stateText);

// ── Phase A: set_overview ────────────────────────────────────────────────────

console.log("\n── Phase A: set_overview ──");
const overviewResult = await setOverviewHandler(ctx, {
	summary: "This PR introduces a `GET /:address/rewards/summary` endpoint that returns per-chain reward rollups (USD totals + per-token raw amounts) without the full campaign/opportunity traversal of the existing `/rewards` route. It also threads `type` and `tokenAddresses` filters down to the DB layer in `LeafRepository`, replacing JS-side filtering in `getRewardsStats`, and adds a `lean` code path to `getBreakdownsByOpportunity` that selects only `{ id, mainProtocolId }` instead of a full eager include. The net effect is a lighter, dashboard-oriented endpoint alongside a modest performance improvement to the existing stats path.",
	risk_level: "medium",
});
printResult("set_overview", overviewResult);

// ── Phase B: diff steps ──────────────────────────────────────────────────────

console.log("\n── Phase B: diff steps ──");

// Step 0
console.log("\n  [B-0] markdown: Token Filter Condition Refactor");
const b0 = await addDiffStepHandler(ctx, {
	step_index: 0,
	markdown: { content: "## Token Filter Condition Refactor\nThe condition controlling when the `Token` filter is applied in `getByRecipient` has been widened." },
});
printResult("add_diff_step[0]", b0);

// Step 1
console.log("\n  [B-1] diff: leaf.repository.ts token filter");
const b1 = await addDiffStepHandler(ctx, {
	step_index: 1,
	diff: {
		file_path: "apps/api/src/modules/v4/leaf/leaf.repository.ts",
		patch: `@@ -39,10 +40,11 @@ export abstract class LeafRepository {
      where: {
        recipient,
        distributionChainId: !!distributionChainIds?.length ? { in: distributionChainIds } : undefined,
-        Token: !options.withTestTokens
+        Token: (!options.withTestTokens || options.type !== undefined || options.tokenAddresses?.length)
          ? {
              type: options.type,
              isTest: options.withTestTokens ? undefined : false,
+              address: options.tokenAddresses?.length ? { in: options.tokenAddresses } : undefined,
            }
          : undefined,`,
		annotation: "Previously the Token filter block was skipped entirely when `withTestTokens` was true, letting all token types through. Now the block is also activated when `type` or `tokenAddresses` is provided — meaning callers that pass `withTestTokens: true` together with a `type` or address list now correctly scope the query, whereas before those extra filters were silently ignored.",
		annotation_position: "right",
	},
});
printResult("add_diff_step[1]", b1);

// Step 2
console.log("\n  [B-2] markdown: Condition Logic Detail");
const b2 = await addDiffStepHandler(ctx, {
	step_index: 2,
	markdown: {
		content: `### Condition Logic Detail

The old condition was simply \`!options.withTestTokens\`. The new condition is:

\`\`\`ts
(!options.withTestTokens || options.type !== undefined || options.tokenAddresses?.length)
\`\`\`

This means the \`Token\` filter block is now entered whenever **any** of the three is true. Inside the block, \`type: options.type\` may still be \`undefined\` (when only \`tokenAddresses\` was the activating condition), which is fine — Prisma treats \`undefined\` fields as "no constraint". The \`isTest\` field correctly uses \`undefined\` (no constraint) rather than \`false\` when \`withTestTokens\` is on, so test tokens are included as expected.

One subtlety: calling with \`{ withTestTokens: true }\` alone (no type, no addresses) still skips the block, preserving the original "all tokens" behavior.`,
	},
});
printResult("add_diff_step[2]", b2);

// Step 3
console.log("\n  [B-3] markdown: Lean Path intro");
const b3 = await addDiffStepHandler(ctx, {
	step_index: 3,
	markdown: {
		content: "## Lean Path for `getBreakdownsByOpportunity`\nThe repository method that fetches per-`(chain, opp, token)` sums previously did a heavy `include` pulling in `MainProtocol`, `Chain`, `Tokens`, `ActivePrograms`, and `DepositUrls` for every opportunity row. The only downstream consumer of that data was protocol-ID filtering.",
	},
});
printResult("add_diff_step[3]", b3);

// Step 4
console.log("\n  [B-4] diff: leaf.repository.ts lean select");
const b4 = await addDiffStepHandler(ctx, {
	step_index: 4,
	diff: {
		file_path: "apps/api/src/modules/v4/leaf/leaf.repository.ts",
		patch: `@@ -249,13 +252,7 @@ export abstract class LeafRepository {
      apiDbClient.opportunity.findMany({
        where: { id: { in: distinctOppIds } },
-        include: {
-          MainProtocol: true,
-          Chain: true,
-          Tokens: true,
-          ActivePrograms: true,
-          DepositUrls: { orderBy: { priority: "asc" } },
-        },
+        select: { id: true, mainProtocolId: true },
      }),
    ]);`,
		annotation: "Replacing the wide `include` with a narrow `select` is the right call — `MainProtocol`, `Chain`, `Tokens`, `ActivePrograms`, and `DepositUrls` were loaded but never read by `getRewardsSummary` or `getRewardsStats`. This reduces the data transferred from the DB and the in-memory footprint of the result set.",
		annotation_position: "left",
	},
});
printResult("add_diff_step[4]", b4);

// Step 5
console.log("\n  [B-5] markdown: Breaking Change Risk");
const b5 = await addDiffStepHandler(ctx, {
	step_index: 5,
	markdown: {
		content: `### Breaking Change Risk on \`getBreakdownsByOpportunity\` Return Type

The \`select: { id, mainProtocolId }\` change narrows the Prisma return type. Any existing caller that destructured \`Chain\`, \`Tokens\`, \`ActivePrograms\`, or \`DepositUrls\` from the result will get a **compile-time error** — which is the correct outcome. However, the \`lean\` overload in \`LeafService\` re-exposes the raw repository return directly:

\`\`\`ts
if (options?.lean) return LeafRepository.getBreakdownsByOpportunity(recipient, distributionChainIds);
\`\`\`

The \`BreakdownsByOpportunityRow\` type used by the non-lean path has \`Opportunity: ... | null\`, so the two branches have different shapes. TypeScript handles this via overloads, but consumers must be careful not to mix them.`,
	},
});
printResult("add_diff_step[5]", b5);

// Step 6
console.log("\n  [B-6] markdown: LeafService overload design");
const b6 = await addDiffStepHandler(ctx, {
	step_index: 6,
	markdown: {
		content: "## `LeafService.getBreakdownsByOpportunity` Overload Design",
	},
});
printResult("add_diff_step[6]", b6);

// Step 7
console.log("\n  [B-7] diff: leaf.service.ts overloads");
const b7 = await addDiffStepHandler(ctx, {
	step_index: 7,
	diff: {
		file_path: "apps/api/src/modules/v4/leaf/leaf.service.ts",
		patch: `@@ -201,7 +201,22 @@ export abstract class LeafService {
 * \`tokenAddress\` keeps every output row single-currency. USD conversion remains a JS-side
 * concern in \`getRewardsSummary\`.
 */
-  static async getBreakdownsByOpportunity(recipient: string, distributionChainIds: number[]) {
+  static getBreakdownsByOpportunity(
+    recipient: string,
+    distributionChainIds: number[],
+    options: { lean: true },
+  ): ReturnType<typeof LeafRepository.getBreakdownsByOpportunity>;
+  static getBreakdownsByOpportunity(
+    recipient: string,
+    distributionChainIds: number[],
+    options?: { lean?: false },
+  ): Promise<BreakdownsByOpportunityRow[]>;
+  static async getBreakdownsByOpportunity(
+    recipient: string,
+    distributionChainIds: number[],
+    options?: { lean?: boolean },
+  ): Promise<Awaited<ReturnType<typeof LeafRepository.getBreakdownsByOpportunity>> | BreakdownsByOpportunityRow[]> {
+    if (options?.lean) return LeafRepository.getBreakdownsByOpportunity(recipient, distributionChainIds);
     if (distributionChainIds.length === 0) return [];`,
		annotation: "The TypeScript overloads correctly narrow the return type: passing `{ lean: true }` returns the raw repository row shape; omitting `lean` (or passing `false`) returns the enriched `BreakdownsByOpportunityRow[]`. The implementation guard `if (options?.lean)` short-circuits to the repository call before the empty-array early-return, meaning a lean call with an empty `distributionChainIds` array will hit the DB unnecessarily — a minor inefficiency.",
		annotation_position: "right",
	},
});
printResult("add_diff_step[7]", b7);

// Flag issue #1: lean + empty array
console.log("\n  [flag_issue] Lean path skips empty-array guard");
const issue1Result = await flagIssueHandler(ctx, {
	severity: "warning",
	title: "Lean path skips the empty-array early-return",
	description: "lean branch returns before distributionChainIds.length === 0 guard, causing an unnecessary DB query",
	block_orders: [7],
	file_path: "apps/api/src/modules/v4/leaf/leaf.service.ts",
	start_line: 222,
	end_line: 222,
});
const issue1Text = printResult("flag_issue[1]", issue1Result);
// Extract issue_id from result (64-char hex SHA-256)
const issue1IdMatch = issue1Text.match(/id: ([a-f0-9]{64})/);
const issue1Id = issue1IdMatch?.[1] ?? "";
if (!issue1Id) { console.error("FATAL: could not extract issue1Id from:", issue1Text); process.exit(1); }
console.log(`  Issue 1 ID: ${issue1Id}`);

// Add comment for issue 1
console.log("\n  [add_issue_comment] lean path empty array");
const comment1Result = await addIssueCommentHandler(ctx, {
	issue_id: issue1Id,
	file_path: "apps/api/src/modules/v4/leaf/leaf.service.ts",
	start_line: 222,
	end_line: 222,
	diff_side: "new",
	body: "The `if (options?.lean)` guard fires before the `distributionChainIds.length === 0` check, so a lean call with an empty chain list hits `LeafRepository.getBreakdownsByOpportunity` with an empty array — most likely generating a Prisma `NOT IN ()` or equivalent no-op query. Move the empty-array guard above the lean branch, or add the same check inside the lean path:\n\n```ts\nif (distributionChainIds.length === 0) return [];\nif (options?.lean) return LeafRepository.getBreakdownsByOpportunity(recipient, distributionChainIds);\n```",
});
printResult("add_issue_comment[1]", comment1Result);

// Step 8
console.log("\n  [B-8] markdown: getRewardsSummary intro");
const b8 = await addDiffStepHandler(ctx, {
	step_index: 8,
	markdown: { content: "## New `getRewardsSummary` Service Method" },
});
printResult("add_diff_step[8]", b8);

// Step 9
console.log("\n  [B-9] diff: user.service.ts getRewardsSummary part 1");
const b9 = await addDiffStepHandler(ctx, {
	step_index: 9,
	diff: {
		file_path: "apps/api/src/modules/v4/user/user.service.ts",
		patch: `@@ -341,6 +341,131 @@ export abstract class UserService {
+  static async getRewardsSummary(address: string, filters: RewardSummaryQuery = {}) {
+    if (await BlacklistService.isBlacklisted(address)) return [];
+
+    const chains = await ChainService.findAll();
+    const roots = await MerklRootService.fetchAll();
+    let chainIds = chains.map(c => c.id).filter(id => roots[id]);
+    if (filters.chains?.length) chainIds = chainIds.filter(id => filters.chains!.map(Number).includes(id));
+    if (chainIds.length === 0) return [];
+
+    const expectedType = filters.isPreTGE === true ? TokenType.PRETGE : TokenType.TOKEN;
+
+    const allLeaves = await LeafService.getByRecipient(address, roots, [], {
+      withToken: true,
+      withTestTokens: filters.isTest ?? false,
+      skipBreakdowns: true,
+      chainFilter: chainIds,
+      type: expectedType,
+      tokenAddresses: filters.tokens,
+    });`,
		annotation: "The method opens with the same chain/root resolution pattern used in `getRewardsStats`, then fetches leaves in a single `getByRecipient` call. `skipBreakdowns: true` avoids loading individual breakdown rows, keeping the initial fetch lightweight. The `type` and `tokenAddresses` filters are now pushed to the DB layer rather than applied in JS.",
		annotation_position: "left",
	},
});
printResult("add_diff_step[9]", b9);

// Step 10
console.log("\n  [B-10] diff: user.service.ts reloadChainId");
const b10 = await addDiffStepHandler(ctx, {
	step_index: 10,
	diff: {
		file_path: "apps/api/src/modules/v4/user/user.service.ts",
		patch: `@@ -370,6 +370,30 @@
+    if (filters.reloadChainId && chainIds.includes(filters.reloadChainId)) {
+      const target = filters.reloadChainId;
+      const chainLeaves = allLeaves.filter(l => l.distributionChainId === target);
+      if (chainLeaves.length > 0) {
+        try {
+          await RewardService.checkLastClaim(target, address, chainLeaves);
+        } catch (err) {
+          userLogger.error(
+            { err, address, chainId: target, operation: "getRewardsSummary.checkLastClaim" },
+            "checkLastClaim failed — returning summary with potentially stale claimed amounts",
+          );
+        }
+      }
+    }`,
		annotation: "The `reloadChainId` path reconciles leaves against on-chain state before aggregation. The try/catch correctly degrades to stale data rather than failing the request. However, `checkLastClaim` mutates `chainLeaves` (a filtered slice of `allLeaves`) in place — this works because `filter` returns references to the same leaf objects, so mutations propagate back to `allLeaves`.",
		annotation_position: "right",
	},
});
printResult("add_diff_step[10]", b10);

// Flag issue #2: implicit mutation
console.log("\n  [flag_issue] In-place mutation of leaves via checkLastClaim");
const issue2Result = await flagIssueHandler(ctx, {
	severity: "warning",
	title: "In-place mutation of leaves via checkLastClaim is implicit",
	description: "checkLastClaim mutates leaf objects via reference; callers have no indication this is a side-effecting call",
	block_orders: [10],
	file_path: "apps/api/src/modules/v4/user/user.service.ts",
	start_line: 383,
	end_line: 396,
});
const issue2Text = printResult("flag_issue[2]", issue2Result);
const issue2IdMatch = issue2Text.match(/id: ([a-f0-9]{64})/);
const issue2Id = issue2IdMatch?.[1] ?? "";
if (!issue2Id) { console.error("FATAL: could not extract issue2Id from:", issue2Text); process.exit(1); }
console.log(`  Issue 2 ID: ${issue2Id}`);

console.log("\n  [add_issue_comment] implicit mutation");
const comment2Result = await addIssueCommentHandler(ctx, {
	issue_id: issue2Id,
	file_path: "apps/api/src/modules/v4/user/user.service.ts",
	start_line: 383,
	end_line: 396,
	diff_side: "new",
	body: "`RewardService.checkLastClaim` mutates the leaf objects it receives to reflect on-chain claim state. This works here because `Array.filter` returns references to the same objects, so mutations to `chainLeaves` propagate back to `allLeaves`. However, this is an implicit contract with no indication at the call-site. If `checkLastClaim`'s signature ever changes to accept a copy, or if `allLeaves` is consumed before this block runs, the reconciliation silently stops having any effect. Consider making the mutation explicit — either have `checkLastClaim` return updated leaves, or add a comment documenting that the mutation is intentional and load-bearing.",
});
printResult("add_issue_comment[2]", comment2Result);

// Step 11
console.log("\n  [B-11] diff: user.service.ts aggregation loop");
const b11 = await addDiffStepHandler(ctx, {
	step_index: 11,
	diff: {
		file_path: "apps/api/src/modules/v4/user/user.service.ts",
		patch: `@@ -400,6 +430,40 @@
+    const result = [];
+    for (const [chainId, chainLeaves] of leavesByChain.entries()) {
+      const chain = chains.find(c => c.id === chainId);
+      if (!chain) continue;
+
+      let amountUSD = 0;
+      let claimedUSD = 0;
+      let pendingUSD = 0;
+      const rewards = chainLeaves.map(leaf => {
+        const token = leaf.RewardToken;
+        const decimals = token.decimals;
+        const amount = BigInt(leaf.amount);
+        const claimed = BigInt(leaf.claimed);
+        const pending = BigInt(leaf.pending);
+
+        const price = token.price ?? 0;
+        if (price) {
+          amountUSD += (bigIntToNumber(amount, decimals) ?? 0) * price;
+          claimedUSD += (bigIntToNumber(claimed, decimals) ?? 0) * price;
+          pendingUSD += (bigIntToNumber(pending, decimals) ?? 0) * price;
+        }
+
+        return {
+          token: TokenFormatter.format(token),
+          amount: amount.toString(),
+          claimed: claimed.toString(),
+          pending: pending.toString(),
+          proofs: leaf.proofs,
+        };
+      });
+
+      result.push({
+        chain: ChainFormatter.format(chain),
+        amountUSD: amountUSD.toString(),
+        claimedUSD: claimedUSD.toString(),
+        pendingUSD: pendingUSD.toString(),
+        rewards,
+      });
+    }
+
+    // Sort per claimable amount first
+    return result.sort(
+      (a, b) =>
+        Number.parseFloat(b.amountUSD) -
+        Number.parseFloat(b.claimedUSD) -
+        Number.parseFloat(b.pendingUSD) -
+        (Number.parseFloat(a.amountUSD) - Number.parseFloat(a.claimedUSD) - Number.parseFloat(a.pendingUSD)),
+    );
+  }`,
		annotation: "USD aggregation accumulates floats from `bigIntToNumber` — which converts token-wei amounts using decimals and a price. The sort at the end orders chains by claimable USD (total − claimed − pending). Note that `result` is typed as `any[]` because it's an untyped `const result = []` — TypeScript infers `never[]` until the first push.",
		annotation_position: "left",
	},
});
printResult("add_diff_step[11]", b11);

// Flag issue #3: proofs exposure
console.log("\n  [flag_issue] Merkle proofs exposed in unauthenticated endpoint");
const issue3Result = await flagIssueHandler(ctx, {
	severity: "warning",
	title: "Merkle proofs exposed in unauthenticated endpoint",
	description: "proofs array in response reveals on-chain claim data without auth check",
	block_orders: [11],
	file_path: "apps/api/src/modules/v4/user/user.service.ts",
	start_line: 448,
	end_line: 448,
});
const issue3Text = printResult("flag_issue[3]", issue3Result);
const issue3IdMatch = issue3Text.match(/id: ([a-f0-9]{64})/);
const issue3Id = issue3IdMatch?.[1] ?? "";
if (!issue3Id) { console.error("FATAL: could not extract issue3Id from:", issue3Text); process.exit(1); }
console.log(`  Issue 3 ID: ${issue3Id}`);

console.log("\n  [add_issue_comment] proofs exposure");
const comment3Result = await addIssueCommentHandler(ctx, {
	issue_id: issue3Id,
	file_path: "apps/api/src/modules/v4/user/user.service.ts",
	start_line: 448,
	end_line: 448,
	diff_side: "new",
	body: "Merkle proofs are included in the per-token reward objects and returned by what appears to be a public, unauthenticated endpoint. While proofs themselves are not secret (they can be derived from the merkle tree), exposing them here increases the attack surface for frontrunning or automated claiming scripts. If this endpoint is intended to be public (no auth), consider whether proofs belong here or should remain gated behind `/rewards`. If proofs are needed, document the intentional decision; if not, remove the `proofs` field from the response DTO.",
});
printResult("add_issue_comment[3]", comment3Result);

// Flag issue #4: float sort precision (info - no comment needed)
console.log("\n  [flag_issue] Sort parseFloat precision (info)");
const issue4Result = await flagIssueHandler(ctx, {
	severity: "info",
	title: "Sort uses parseFloat on USD strings — potential precision loss",
	description: "Number.parseFloat on large USD strings may lose precision for high-value wallets",
	block_orders: [11],
	file_path: "apps/api/src/modules/v4/user/user.service.ts",
	start_line: 467,
	end_line: 473,
});
printResult("flag_issue[4]", issue4Result);

// Step 12
console.log("\n  [B-12] markdown: getRewardsStats refactor intro");
const b12 = await addDiffStepHandler(ctx, {
	step_index: 12,
	markdown: { content: "## `getRewardsStats` Refactor — Filter Push-down" },
});
printResult("add_diff_step[12]", b12);

// Step 13
console.log("\n  [B-13] diff: user.service.ts filter push-down");
const b13 = await addDiffStepHandler(ctx, {
	step_index: 13,
	diff: {
		file_path: "apps/api/src/modules/v4/user/user.service.ts",
		patch: `@@ -288,32 +288,32 @@ export abstract class UserService {
+    const expectedType = filters.isPreTGE === true ? TokenType.PRETGE : TokenType.TOKEN;
+
     const leaves = await LeafService.getByRecipient(address, roots, [], {
       withToken: true,
       withTestTokens: filters.isTest ?? false,
       skipBreakdowns: true,
       chainFilter: chainIds,
+      type: expectedType,
+      tokenAddresses: filters.tokens,
     });
 
     // Pre-flight to resolve valid (chain:token) pairs when a protocol filter is active.
     let protocolTokenKeys: Set<string> | null = null;
     if (filters.protocols?.length) {
-      const breakdowns = await LeafRepository.getBreakdownsByOpportunity(address, chainIds);
+      const breakdowns = await LeafService.getBreakdownsByOpportunity(address, chainIds, { lean: true });
       const valid = breakdowns.filter(
         b => b.Opportunity && filters.protocols!.includes(b.Opportunity.mainProtocolId ?? ""),
       );
       protocolTokenKeys = new Set(valid.map(b => \`\${b.distributionChainId}:\${b.tokenAddress}\`));
     }
 
-    const expectedType = filters.isPreTGE === true ? TokenType.PRETGE : TokenType.TOKEN;
-
     let totalEarnedUSD = 0;
     let pendingUSD = 0;
     let claimableUSD = 0;
 
     for (const leaf of leaves) {
-      if (leaf.RewardToken.type !== expectedType) continue;
-      if (filters.tokens?.length && !filters.tokens.includes(leaf.RewardToken.address)) continue;
       if (protocolTokenKeys && !protocolTokenKeys.has(\`\${leaf.distributionChainId}:\${leaf.RewardToken.address}\`))
         continue;`,
		annotation: "The two JS-side filter guards (`type !== expectedType` and `tokens.includes`) have been removed from the loop and replaced by DB-level filters passed to `getByRecipient`. This is a correct and meaningful optimization — the result set fetched from the DB is now narrower. Callers using `LeafRepository.getBreakdownsByOpportunity` directly have been upgraded to `LeafService.getBreakdownsByOpportunity(..., { lean: true })`, which uses the same select optimization.",
		annotation_position: "right",
	},
});
printResult("add_diff_step[13]", b13);

// Step 14
console.log("\n  [B-14] markdown: New endpoint and DTOs");
const b14 = await addDiffStepHandler(ctx, {
	step_index: 14,
	markdown: { content: "## New Endpoint and DTOs" },
});
printResult("add_diff_step[14]", b14);

// Step 15
console.log("\n  [B-15] diff: user.controller.ts new endpoint");
const b15 = await addDiffStepHandler(ctx, {
	step_index: 15,
	diff: {
		file_path: "apps/api/src/modules/v4/user/user.controller.ts",
		patch: `@@ -166,6 +168,26 @@ export const UserController = new Elysia({ prefix: "/users", detail: { tags: ["U
+  .get("/:address/rewards/summary", async ({ params, query }) => UserService.getRewardsSummary(params.address, query), {
+    params: UserUniqueDto,
+    query: RewardSummaryQueryDto,
+    beforeHandle: ({ params, query, set, cookie, headers }) => {
+      setCacheHeaders(0)({ set, cookie, headers });
+      if (!!query.reloadChainId) throwOnUnsupportedChainId(query.reloadChainId);
+      params.address = throwOnInvalidRequiredAddress(params.address);
+      query.chains = query.chains?.flatMap(x => x.split(","));
+      query.tokens = query.tokens?.flatMap(x => x.split(","));
+      query.protocols = query.protocols?.flatMap(x => x.split(","));
+    },
+    response: UserRewardsSummaryResourceDto,`,
		annotation: "The endpoint is registered with `setCacheHeaders(0)` — always uncached — which is correct for user-specific, potentially post-claim data. The `beforeHandle` normalises comma-separated query params (matching the pattern in adjacent endpoints) and validates the address. No authentication guard is applied here.",
		annotation_position: "left",
	},
});
printResult("add_diff_step[15]", b15);

// Flag issue #5: no auth on /rewards/summary
console.log("\n  [flag_issue] No auth on /rewards/summary");
const issue5Result = await flagIssueHandler(ctx, {
	severity: "warning",
	title: "No authentication guard on /rewards/summary",
	description: "endpoint returns per-user financial data and merkle proofs without auth check",
	block_orders: [15],
	file_path: "apps/api/src/modules/v4/user/user.controller.ts",
	start_line: 171,
	end_line: 192,
});
const issue5Text = printResult("flag_issue[5]", issue5Result);
const issue5IdMatch = issue5Text.match(/id: ([a-f0-9]{64})/);
const issue5Id = issue5IdMatch?.[1] ?? "";
if (!issue5Id) { console.error("FATAL: could not extract issue5Id from:", issue5Text); process.exit(1); }
console.log(`  Issue 5 ID: ${issue5Id}`);

console.log("\n  [add_issue_comment] no auth");
const comment5Result = await addIssueCommentHandler(ctx, {
	issue_id: issue5Id,
	file_path: "apps/api/src/modules/v4/user/user.controller.ts",
	start_line: 171,
	end_line: 192,
	diff_side: "new",
	body: "The `/rewards/summary` endpoint returns per-user financial data (USD totals, claimed amounts) and merkle proofs without any authentication middleware. Compare with adjacent endpoints in this file — do they also omit auth? If this is intentional (data is public by address, matching `/rewards` behavior), add a comment explicitly noting the decision. If auth is expected, add the appropriate guard. The presence of merkle proofs in the response makes this more sensitive than a simple balance query.",
});
printResult("add_issue_comment[5]", comment5Result);

// Step 16
console.log("\n  [B-16] diff: user.model.ts new DTO");
const b16 = await addDiffStepHandler(ctx, {
	step_index: 16,
	diff: {
		file_path: "apps/api/src/modules/v4/user/user.model.ts",
		patch: `@@ -94,6 +94,30 @@ export const UserRewardsStatsResourceDto = t.Object({
+export const UserRewardsSummaryResourceDto = t.Array(
+  t.Object({
+    chain: ChainResourceDto,
+    amountUSD: t.String({ description: "Total earned USD across all tokens on this chain" }),
+    claimedUSD: t.String({ description: "Total claimed USD" }),
+    pendingUSD: t.String({ description: "Total pending USD" }),
+    rewards: t.Array(
+      t.Object({
+        token: TokenResourceDto,
+        amount: t.String({ description: "Raw token amount (wei)" }),
+        claimed: t.String({ description: "Claimed token amount (wei)" }),
+        pending: t.String({ description: "Pending token amount (wei)" }),
+        proofs: t.Array(t.String({ description: "Merkle proof hash" }), { description: "Merkle proofs for claiming" }),
+      }),
+    ),
+  }),
+);`,
		annotation: "The DTO correctly models the per-chain array structure. USD fields are serialized as strings to avoid floating-point precision issues in JSON. The `proofs` field is typed as `t.Array(t.String(...))` — its presence in the response schema is the root of the auth/exposure concern flagged above.",
		annotation_position: "right",
	},
});
printResult("add_diff_step[16]", b16);

// ── Phase C: set_sentiment ────────────────────────────────────────────────────

console.log("\n── Phase C: set_sentiment ──");
const sentimentResult = await setSentimentHandler(ctx, {
	markdown: "This PR is close to merge-ready. The core feature — a lightweight `/rewards/summary` endpoint with DB-level filtering — is well-structured and the `lean` path optimization is the right approach. The main concerns are: (1) the absence of an explicit auth decision on the new endpoint, which returns merkle proofs; (2) the implicit in-place mutation contract on `checkLastClaim`; and (3) the minor lean-path ordering bug that sends an unnecessary DB query for empty chain lists. None of these are hard blockers, but the auth/proofs decision should be documented or enforced before merge.",
});
printResult("set_sentiment", sentimentResult);

// ── Phase D: rate_axis ────────────────────────────────────────────────────────

console.log("\n── Phase D: rate_axis (9 axes) ──");

const axes = [
	{
		axis: "correctness" as const,
		verdict: "concern" as const,
		confidence: "medium" as const,
		rationale: "The lean path in `LeafService.getBreakdownsByOpportunity` skips the `distributionChainIds.length === 0` early-return guard, sending an unnecessary DB query when called with an empty array. The filter condition change in `getByRecipient` is logically correct but the ordering of checks should be verified.",
		details: `### Lean Path Early-Return Bug\n\nThe overload implementation places \`if (options?.lean)\` **before** the existing \`if (distributionChainIds.length === 0) return []\` guard:\n\n\`\`\`ts\nif (options?.lean) return LeafRepository.getBreakdownsByOpportunity(recipient, distributionChainIds);\nif (distributionChainIds.length === 0) return [];\n\`\`\`\n\nA lean call with an empty chain list will hit Prisma with an empty \`WHERE id IN ()\` clause — most databases handle this gracefully, but it is a wasteful round-trip that the original non-lean path explicitly avoids. The fix is one line: move the empty-array guard above the lean branch.\n\n### Filter Condition Change\n\nThe widened Token filter condition in \`getByRecipient\` is logically sound. The new OR chain \`(!withTestTokens || type !== undefined || tokenAddresses?.length)\` is additive — it activates the filter block for more cases without removing any existing constraint. The behavior for the original \`withTestTokens: false\` caller is unchanged.`,
		citations: [{ file_path: "apps/api/src/modules/v4/leaf/leaf.service.ts", start_line: 222, end_line: 222, note: null }],
	},
	{
		axis: "scope" as const,
		verdict: "pass" as const,
		confidence: "high" as const,
		rationale: "The PR does one cohesive thing: add a summary endpoint with a lean DB path. The `getRewardsStats` refactor is a natural prerequisite, not a drive-by.",
		details: "The changes are tightly focused: new `getRewardsSummary` service method, a new controller route, new DTOs, and the `lean` optimization to `getBreakdownsByOpportunity`. The `getRewardsStats` filter push-down is directly related — it reuses the same infrastructure (`tokenAddresses`, `type` at DB level) that `getRewardsSummary` introduces. No unrelated formatting changes or drive-by refactors were identified. Scope is appropriate for a single PR.",
		citations: [],
	},
	{
		axis: "tests" as const,
		verdict: "concern" as const,
		confidence: "low" as const,
		rationale: "No tests are present in the diff for the new `getRewardsSummary` method, the `tokenAddresses` filter, or the `lean` overload. Couldn't verify whether a test file exists elsewhere.",
		details: `### Missing Test Coverage\n\nThree new behaviors are introduced with no visible test coverage in the diff:\n\n- **\`getRewardsSummary\`** — the entire aggregation loop, USD calculation, \`reloadChainId\` path, and sort logic are untested.\n- **\`tokenAddresses\` DB filter** — the widened Token condition in \`getByRecipient\` is a subtle change; a test verifying that \`{ withTestTokens: true, tokenAddresses: [...] }\` correctly scopes results would catch regressions.\n- **\`lean\` overload** — the short-circuit path and its interaction with the empty-array guard are untested.\n\nConfidence is low because it's possible tests exist in a separate test file not included in the diff. However, the empty-array lean bug strongly suggests the lean path was not exercised.`,
		citations: [{ file_path: "apps/api/src/modules/v4/user/user.service.ts", start_line: 341, end_line: 471, note: null }],
	},
	{
		axis: "clarity" as const,
		verdict: "pass" as const,
		confidence: "high" as const,
		rationale: "Method JSDoc, inline comments, and the overload design are all clear. The `BreakdownsByOpportunityRow` local type improves readability. The untyped `const result = []` is a minor nit.",
		details: "The JSDoc on `getBreakdownsByOpportunity` clearly explains the currency-per-row invariant. The TypeScript overloads are named and typed in a way that makes the lean/full distinction obvious to callers. The `BreakdownsByOpportunityRow` local type alias prevents repetitive inline types. The only minor issue is `const result = []` without a type annotation — TypeScript infers `never[]` until the first push, which can cause confusing type errors on `.map()` or `.filter()` calls on the result before the push. Adding an explicit type annotation would be a clean improvement.",
		citations: [],
	},
	{
		axis: "safety" as const,
		verdict: "concern" as const,
		confidence: "medium" as const,
		rationale: "Merkle proofs are included in the response of what appears to be an unauthenticated endpoint. The auth posture of the new route is not explicit.",
		details: `### Merkle Proofs on Unauthenticated Endpoint\n\nThe new \`GET /:address/rewards/summary\` endpoint returns \`proofs: string[]\` in every per-token reward object. Merkle proofs are the on-chain credentials needed to submit a claim transaction — exposing them in a high-traffic, publicly-accessible endpoint increases the attack surface for:\n\n- **Frontrunning**: automated scripts can poll this endpoint and submit claims on behalf of users.\n- **Bulk claim bots**: adversaries can index proofs across many addresses cheaply.\n\nWhile proofs can technically be derived from the public merkle tree, having them delivered on a silver platter is meaningfully different. The `/rewards` route (which also returns proofs) should be checked for its auth posture — if it is also unauthenticated, this endpoint is consistent. If it requires auth, this endpoint is a regression. Either way, the decision should be documented in a comment.`,
		citations: [{ file_path: "apps/api/src/modules/v4/user/user.controller.ts", start_line: 171, end_line: 192, note: null }],
	},
	{
		axis: "consistency" as const,
		verdict: "pass" as const,
		confidence: "high" as const,
		rationale: "Follows established patterns: same chain/root resolution preamble as `getRewardsStats`, same comma-split query normalisation in `beforeHandle`, same string serialisation for USD values.",
		details: "The new endpoint follows all established conventions in the codebase: `setCacheHeaders(0)` for user-specific routes, `flatMap(x => x.split(','))` for array query params, `t.String()` for USD values in DTOs to avoid JSON float precision loss, and `throwOnInvalidRequiredAddress` for address validation. The service method opens with the same `chains + roots → chainIds` preamble that `getRewardsStats` uses. The `lean` naming for the lightweight path is consistent with patterns used elsewhere in the codebase.",
		citations: [],
	},
	{
		axis: "api_changes" as const,
		verdict: "concern" as const,
		confidence: "high" as const,
		rationale: "New public endpoint `GET /:address/rewards/summary` is additive but the `getBreakdownsByOpportunity` return-type narrowing (removing `MainProtocol`, `Chain`, `Tokens`, etc.) is a breaking change to any callers outside this diff.",
		details: `### New Endpoint (Additive)\n\n\`GET /:address/rewards/summary\` is a new route — purely additive, no existing callers affected.\n\n### Breaking Return-Type Change on \`getBreakdownsByOpportunity\`\n\nThe \`select: { id: true, mainProtocolId: true }\` change narrows the Prisma return type from a shape that included \`MainProtocol\`, \`Chain\`, \`Tokens\`, \`ActivePrograms\`, and \`DepositUrls\` to one that includes only \`id\` and \`mainProtocolId\`. Any caller that accessed those removed fields will now get a **TypeScript compile error** — which is the correct mechanism. The diff shows all callers have been updated, but this should be verified with a full type-check (\`tsc --noEmit\`) across the monorepo before merge.`,
		citations: [{ file_path: "apps/api/src/modules/v4/leaf/leaf.repository.ts", start_line: 252, end_line: 258, note: null }],
	},
	{
		axis: "performance" as const,
		verdict: "pass" as const,
		confidence: "high" as const,
		rationale: "Filter push-down to DB layer and the `select { id, mainProtocolId }` optimization are both improvements. `skipBreakdowns: true` keeps the leaf fetch lean.",
		details: "Three concrete performance improvements land in this PR:\n\n1. **`select { id, mainProtocolId }`** replaces a wide `include` that loaded five related tables for every opportunity row. For a wallet with many opportunities this is a meaningful reduction in both query time and in-memory allocation.\n2. **DB-level `type` + `tokenAddresses` filters** in `getByRecipient` replace JS-side `Array.filter` loops in `getRewardsStats`. The result set returned from the DB is now narrower, reducing deserialization and application memory.\n3. **`skipBreakdowns: true`** in `getRewardsSummary` avoids fetching individual breakdown rows entirely, keeping the initial leaf fetch lightweight for the dashboard use-case.\n\nNo new N+1 patterns or unbounded loops were introduced.",
		citations: [],
	},
	{
		axis: "description" as const,
		verdict: "pass" as const,
		confidence: "medium" as const,
		rationale: "The endpoint has a descriptive `detail.description` in the controller. No PR description is available in the diff context.",
		details: "The controller registration includes a `detail: { tags: [...], description: '...' }` block that describes the endpoint's purpose for the OpenAPI spec. The JSDoc on `getRewardsSummary` and the overload signatures are informative. No PR description was available in the diff context to assess the 'why' and deployment notes — confidence is medium as a result. The inline code comments adequately compensate for the absence of a PR body.",
		citations: [],
	},
];

for (const axisInput of axes) {
	console.log(`\n  [rate_axis] ${axisInput.axis}`);
	const result = await rateAxisHandler(ctx, {
		axis: axisInput.axis,
		verdict: axisInput.verdict,
		confidence: axisInput.confidence,
		rationale: axisInput.rationale,
		details: axisInput.details,
		citations: axisInput.citations,
		block_orders: [],
	});
	printResult(`rate_axis[${axisInput.axis}]`, result);
}

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

console.log(`\n✅ Pipeline complete! Walkthrough ${WALKTHROUGH_ID} is now 'complete'.`);
console.log(`Total events emitted: ${events.length}`);
