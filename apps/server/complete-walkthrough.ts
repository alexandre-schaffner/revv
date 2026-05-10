/**
 * One-shot script: complete walkthrough d8c48fcf-02e4-46b6-9de8-7648f4433f0a
 * by rating the 3 missing axes then calling complete_walkthrough.
 *
 * Run with: bun complete-walkthrough.ts
 */

import { createDb } from "./src/db";
import type { WalkthroughToolContext } from "./src/ai/providers/walkthrough-tool-spec";
import {
	rateAxisHandler,
	completeWalkthroughHandler,
} from "./src/ai/providers/walkthrough-tools";

const WALKTHROUGH_ID = "d8c48fcf-02e4-46b6-9de8-7648f4433f0a";
const DB_PATH = "/Users/alex/Projects/revv/apps/server/revv-dev.db";

const db = createDb(DB_PATH);

const ctx: WalkthroughToolContext = {
	db,
	walkthroughId: WALKTHROUGH_ID,
	emit: () => {},
	broadcastThreadEvent: () => {},
};

// ── 1. rate_axis: api_changes ────────────────────────────────────────────────
console.log("=== rate_axis: api_changes ===");
const apiChangesResult = await rateAxisHandler(ctx, {
	axis: "api_changes",
	verdict: "concern",
	confidence: "medium",
	rationale:
		"PR adds `UNCLAIMED_DISTRIBUTOR` campaign type (CampaignType 192) to a large enum shared across services. No API-breaking changes, but adding a new campaign type is a contract change for consumers that enumerate campaign types.",
	details: "",
	citations: [
		{
			file_path: "packages/resources/src/enums/campaignType.ts",
			start_line: 180,
			end_line: 180,
			note: null,
		},
	],
	block_orders: [],
});
console.log(JSON.stringify(apiChangesResult, null, 2));

// ── 2. rate_axis: performance ────────────────────────────────────────────────
console.log("\n=== rate_axis: performance ===");
const performanceResult = await rateAxisHandler(ctx, {
	axis: "performance",
	verdict: "concern",
	confidence: "medium",
	rationale:
		"`TreeUpdated` handler loads all leaves for every new root on every block scan. With large trees this is an unbounded DB read per event. The `findPrevRoot` linear scan is O(n) in roots observed.",
	details: "",
	citations: [
		{
			file_path:
				"apps/engine/src/indexer/indexers/EVM/eventconfigs/unclaimedDistributor/buildUnclaimedDistributorConfig.ts",
			start_line: 60,
			end_line: 73,
			note: null,
		},
	],
	block_orders: [],
});
console.log(JSON.stringify(performanceResult, null, 2));

// ── 3. rate_axis: description ────────────────────────────────────────────────
console.log("\n=== rate_axis: description ===");
const descriptionResult = await rateAxisHandler(ctx, {
	axis: "description",
	verdict: "pass",
	confidence: "high",
	rationale:
		"PR description explains what UNCLAIMED_DISTRIBUTOR does and the event model. The four-event-stream design is documented both in code comments and in the protocol knowledge file.",
	details: "",
	citations: [],
	block_orders: [],
});
console.log(JSON.stringify(descriptionResult, null, 2));

// ── 4. complete_walkthrough ──────────────────────────────────────────────────
console.log("\n=== complete_walkthrough ===");
const completeResult = await completeWalkthroughHandler(ctx, {
	walkthrough_id: WALKTHROUGH_ID,
});
console.log(JSON.stringify(completeResult, null, 2));
