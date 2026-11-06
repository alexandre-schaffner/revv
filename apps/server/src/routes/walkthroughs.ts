// ── Walkthrough lifecycle queries ───────────────────────────────────────────
//
// Account-scoped endpoints the client calls outside the per-PR review flow:
//   • GET /api/walkthroughs/active — list in-flight jobs for the user's
//     account so the SSE client can seed sidebar spinners + `lastSeenSeq`
//     cursors on (re)connect. Returns the cursor `seqAt = next_seq - 1` per
//     row; clients must pair that cursor with a REST snapshot before dropping
//     older envelopes.

import { Effect } from "effect";
import { Elysia } from "elysia";
import { WalkthroughService } from "../services/Walkthrough";
import { runRoute, withAccount } from "./middleware";

export const walkthroughsRoute = new Elysia({ prefix: "/api/walkthroughs" })
  .use(withAccount)
  .get("/active", (ctx) =>
    runRoute(
      Effect.flatMap(WalkthroughService, (wts) =>
        wts.listActiveForAccount(ctx.account.accountId),
      ).pipe(Effect.map((walkthroughs) => ({ walkthroughs }))),
    ),
  );
