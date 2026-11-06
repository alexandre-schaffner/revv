import type { ThreadEventMessage } from "@revv/shared";
import { Effect } from "effect";
import { AppRuntime } from "../../runtime";
import { Realtime } from "../../services/Realtime";

/**
 * Push a thread event from an MCP tool handler without waiting on it. Pass
 * `accountId` when the caller already holds it; otherwise it is resolved from
 * the PR.
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
