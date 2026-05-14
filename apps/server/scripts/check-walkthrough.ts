import { createDb } from "./src/db/index";
import { getWalkthroughStateHandler } from "./src/ai/providers/walkthrough-tools";

const WALKTHROUGH_ID = process.argv[2] ?? "4a03f90a-5c7c-42ee-8e82-23c050105888";
const DB_PATH = "./revv-dev.db";

const db = createDb(DB_PATH);
const ctx = { db, walkthroughId: WALKTHROUGH_ID, emit: () => {}, broadcastThreadEvent: () => {} };

const result = await getWalkthroughStateHandler(ctx, { walkthrough_id: WALKTHROUGH_ID });

console.log(JSON.stringify(result, null, 2));

for (const block of result.content) {
	if (block.type === "text") {
		try {
			const jsonStart = block.text.indexOf("{");
			if (jsonStart !== -1) {
				const parsed = JSON.parse(block.text.slice(jsonStart));
				console.log("\n--- Parsed WalkthroughState ---");
				console.log(JSON.stringify(parsed, null, 2));
			}
		} catch {
			console.log("\n--- Raw text ---");
			console.log(block.text);
		}
	}
}
