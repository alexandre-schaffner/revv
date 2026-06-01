import type { ThreadEventMessage } from "@revv/shared";
import { Effect } from "effect";
import { logError } from "../logger";
import { AppRuntime } from "../runtime";
import { Broadcaster } from "./Broadcaster";
import { PrContextService } from "./PrContext";
import { RepositoryService } from "./Repository";

/**
 * Fire-and-forget SSE broadcast for thread events.
 *
 * When `accountId` is provided it is used directly, avoiding DB lookups for
 * `(prId, userId)` → repo → account resolution. Callers that already have
 * `accountId` in scope (e.g. from an ActiveJob or session-token resolution)
 * should always pass it to avoid redundant round-trips during burst tool calls.
 */
export function fireAndForgetThreadEventBroadcast(
  logScope: string,
  prId: string,
  userId: string,
  msg: ThreadEventMessage,
  accountId?: string,
): void {
  const effect =
    accountId !== undefined
      ? Effect.flatMap(Broadcaster, (broadcaster) => broadcaster.broadcastToAccount(accountId, msg))
      : Effect.gen(function* () {
          const prContext = yield* PrContextService;
          const repoService = yield* RepositoryService;
          const broadcaster = yield* Broadcaster;
          const { repo } = yield* prContext.resolveBasic(prId, userId);
          const resolvedAccountId = yield* repoService.getAccountIdForRepo(repo.id);
          yield* broadcaster.broadcastToAccount(resolvedAccountId, msg);
        });

  void AppRuntime.runPromise(effect).catch((err) => {
    logError(
      logScope,
      "thread event broadcast failed:",
      err instanceof Error ? err.message : String(err),
    );
  });
}
