// What follows a committed post-completion edit, for every path that makes
// one (in-app chat, external agents): `lifecycle:edited`, the edit's events,
// and a push of the edited walkthrough to the team cache.

import type { WalkthroughStreamEvent } from "@revv/shared";
import { Effect } from "effect";
import { RemoteWalkthroughCache } from "../RemoteWalkthroughCache";
import { WalkthroughJobs } from "../WalkthroughJobs";

export const publishWalkthroughEdit = (
  walkthroughId: string,
  events: readonly WalkthroughStreamEvent[],
): Effect.Effect<void, never, WalkthroughJobs | RemoteWalkthroughCache> =>
  Effect.gen(function* () {
    const jobs = yield* WalkthroughJobs;
    yield* jobs.emitEvent(walkthroughId, {
      type: "lifecycle:edited",
      data: { walkthroughId, editedAt: new Date().toISOString() },
    });
    for (const event of events) yield* jobs.emitEvent(walkthroughId, event);
    const cache = yield* RemoteWalkthroughCache;
    // A failed push is logged by the cache and costs only the team copy.
    yield* cache.push(walkthroughId).pipe(Effect.ignore);
  });
