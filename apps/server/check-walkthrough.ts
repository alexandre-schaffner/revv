// One-off script: call get_walkthrough_state for a given walkthrough ID
// Usage: bun run check-walkthrough.ts
import { createDb } from "./src/db/index";
import { getWalkthroughStateHandler } from "./src/ai/providers/walkthrough-tools";

const WALKTHROUGH_ID = "d8c48fcf-02e4-46b6-9de8-7648f4433f0a";
const DB_PATH = "/Users/alex/Projects/revv/apps/server/revv-dev.db";

const db = createDb(DB_PATH);

const ctx = {
	db,
	walkthroughId: WALKTHROUGH_ID,
	emit: (_event: unknown) => {
		// no-op: read-only tool doesn't emit
	},
	broadcastThreadEvent: (_event: unknown) => {
		// no-op
	},
};

const result = await getWalkthroughStateHandler(ctx, { walkthrough_id: WALKTHROUGH_ID });

console.log(JSON.stringify(result, null, 2));

// If the result content is a JSON string, pretty-print it too
for (const block of result.content) {
	if (block.type === "text") {
		try {
			// Strip any WARNING prefix to get the JSON portion
			const jsonStart = block.text.indexOf("{");
			if (jsonStart !== -1) {
				const parsed = JSON.parse(block.text.slice(jsonStart));
				console.log("\n--- Parsed WalkthroughState ---");
				console.log(JSON.stringify(parsed, null, 2));
			}
		} catch {
			// text wasn't JSON, just print raw
			console.log("\n--- Raw text ---");
			console.log(block.text);
		}
	}
}
