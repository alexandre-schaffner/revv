// Fire-and-forget publishing for MCP tool handlers, which run outside Effect
// and must not wait on a broadcast (invariant 8: the commit already happened).

import type { ThreadEventMessage, WalkthroughStreamEvent } from "@revv/shared";
import { Effect } from "effect";
import { logError } from "../../logger";
import { AppRuntime } from "../../runtime";
import { Realtime } from "../../services/Realtime";
import { publishWalkthroughEdit } from "../../services/walkthrough/edits";

/** Push a thread event to the PR's owning account, resolved per event (`Realtime.toPr`). */
export function fireAndForgetThreadEventBroadcast(prId: string, msg: ThreadEventMessage): void {
  AppRuntime.runPromise(Effect.flatMap(Realtime, (realtime) => realtime.toPr(prId, msg))).catch(
    (err: unknown) => {
      logError(
        "mcp-thread",
        `broadcasting ${msg.type} for ${prId} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    },
  );
}

export function fireAndForgetWalkthroughEdit(
  walkthroughId: string,
  events: readonly WalkthroughStreamEvent[],
): void {
  AppRuntime.runPromise(publishWalkthroughEdit(walkthroughId, events)).catch((err: unknown) => {
    logError(
      "mcp-edit",
      `publishing the edit of ${walkthroughId} failed:`,
      err instanceof Error ? err.message : String(err),
    );
  });
}
