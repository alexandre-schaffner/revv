// Fire-and-forget publishing for MCP tool handlers, which run outside Effect
// and must not wait on a broadcast (invariant 8: the commit already happened).

import type { ThreadEventMessage, WalkthroughStreamEvent } from "@revv/shared";
import { Effect } from "effect";
import { logError } from "../../logger";
import { AppRuntime } from "../../runtime";
import { Realtime } from "../../services/Realtime";
import { publishWalkthroughEdit } from "../../services/walkthrough/edits";

/**
 * Push a thread event. Pass `accountId` when the caller already holds it;
 * otherwise it is resolved from the PR.
 */
export function fireAndForgetThreadEventBroadcast(
  prId: string,
  msg: ThreadEventMessage,
  accountId?: string,
): void {
  void AppRuntime.runPromise(
    Effect.flatMap(Realtime, (realtime) =>
      accountId !== undefined ? realtime.toAccount(accountId, msg) : realtime.toPr(prId, msg),
    ),
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
