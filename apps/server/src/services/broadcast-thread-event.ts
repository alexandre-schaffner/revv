import type { ThreadEventMessage } from "@revv/shared";
import { Effect } from "effect";
import { logError } from "../logger";
import { AppRuntime } from "../runtime";
import { Broadcaster } from "./Broadcaster";
import { PrContextService } from "./PrContext";
import { RepositoryService } from "./Repository";

export function fireAndForgetThreadEventBroadcast(
  logScope: string,
  prId: string,
  userId: string,
  msg: ThreadEventMessage,
): void {
  void AppRuntime.runPromise(
    Effect.gen(function* () {
      const prContext = yield* PrContextService;
      const repoService = yield* RepositoryService;
      const broadcaster = yield* Broadcaster;
      const { repo } = yield* prContext.resolveBasic(prId, userId);
      const accountId = yield* repoService.getAccountIdForRepo(repo.id);
      yield* broadcaster.broadcastToAccount(accountId, msg);
    }),
  ).catch((err) => {
    logError(
      logScope,
      "thread event broadcast failed:",
      err instanceof Error ? err.message : String(err),
    );
  });
}
