// ── Walkthrough lifecycle queries ───────────────────────────────────────────
//
// Account-scoped endpoints the client calls outside the per-PR review flow:
//   • GET /api/walkthroughs/active — list in-flight jobs for the user's
//     account so the SSE client can seed sidebar spinners + `lastSeenSeq`
//     cursors on (re)connect. Returns the cursor `seqAt = next_seq - 1` per
//     row; future SSE envelopes with `seq > seqAt` apply normally; any
//     in-flight envelope with `seq <= seqAt` is dropped defensively by
//     the client reducer.

import { Effect } from "effect";
import { Elysia } from "elysia";
import { logError } from "../logger";
import { AppRuntime } from "../runtime";
import { WalkthroughService } from "../services/Walkthrough";
import { handleAppError, withAccount } from "./middleware";

export const walkthroughsRoute = new Elysia({ prefix: "/api/walkthroughs" })
  .use(withAccount)
  .get("/active", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.gen(function* () {
          const wts = yield* WalkthroughService;
          const rows = yield* wts.listActiveForAccount(ctx.account.accountId);
          return { walkthroughs: rows };
        }),
      );
    } catch (err) {
      logError(
        "walkthroughs-active",
        "failed to list active walkthroughs:",
        err instanceof Error ? err.message : String(err),
      );
      return handleAppError(err, ctx);
    }
  });
