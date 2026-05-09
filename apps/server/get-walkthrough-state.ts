import { createDb } from "./src/db";
import { pullRequests } from "./src/db/schema/pull-requests";
import { walkthroughs } from "./src/db/schema/walkthroughs";
import { eq, desc } from "drizzle-orm";
import { getWalkthroughStateHandler } from "./src/ai/providers/walkthrough-tools";

const db = createDb("./revv.db");

const pr = db.select()
  .from(pullRequests)
  .where(eq(pullRequests.sourceBranch, "add-new-chain-checklist"))
  .get();

if (!pr) {
  console.error("PR not found for branch add-new-chain-checklist");
  process.exit(1);
}

console.log(`Found PR: ${pr.title} (ID: ${pr.id}, Head SHA: ${pr.headSha})`);

const walkthrough = db.select()
  .from(walkthroughs)
  .where(eq(walkthroughs.pullRequestId, pr.id))
  .orderBy(desc(walkthroughs.generatedAt))
  .limit(1)
  .get();

if (!walkthrough) {
  console.log("No walkthrough found for this PR. You are starting fresh.");
} else {
  console.log(`Found walkthrough: ${walkthrough.id} (Status: ${walkthrough.status}, Phase: ${walkthrough.lastCompletedPhase}, SHA: ${walkthrough.prHeadSha})`);
  
  const ctx = {
    db,
    walkthroughId: walkthrough.id,
    emit: (event: any) => {},
    broadcastThreadEvent: (msg: any) => {},
  };

  const stateResult = await getWalkthroughStateHandler(ctx as any, {});
  console.log("\nCurrent Walkthrough State:");
  console.log(stateResult.content[0].text);
}
