// After Revv pushes to a PR's source branch, the PR row has to learn the new
// head before the next poll does, or the review page keeps showing the old
// one. Shared by the chat push (`ChatChangesPush`) and the base sync
// (`BaseConflicts`).

import { type Context, Effect } from "effect";
import { STACK_UNSEEN } from "../domain/observed-pr";
import type { Broadcaster } from "./Broadcaster";
import type { PrContextService } from "./PrContext";
import type { PullRequestService } from "./PullRequest";

interface Deps {
  readonly prService: Context.Service.Shape<typeof PullRequestService>;
  readonly prCtx: Context.Service.Shape<typeof PrContextService>;
  readonly broadcaster: Context.Service.Shape<typeof Broadcaster>;
}

export const makePrHeadRefresh = ({ prService, prCtx, broadcaster }: Deps) => {
  /** Record `newTip` (or GitHub's answer, when it has one) as the PR's head. */
  const recordPushedHead = (params: {
    readonly prId: string;
    readonly repoFullName: string;
    readonly prExternalId: number;
    readonly token: string;
    readonly newTip: string;
  }) =>
    Effect.gen(function* () {
      const fresh = yield* prService
        .listPrs()
        .pipe(Effect.map((prs) => prs.find((p) => p.id === params.prId) ?? null));
      if (!fresh) return;
      const metaOpt = yield* prCtx
        .prMeta(params.repoFullName, params.prExternalId, params.token)
        .pipe(Effect.option);
      const headSha = metaOpt._tag === "Some" ? metaOpt.value.headSha : params.newTip;
      const now = new Date().toISOString();
      // Advance `updatedAt` with the head, never one without the other.
      // `fresh` is the DB row, so its `updatedAt` predates this push; a row
      // left at `(newHead, oldUpdatedAt)` is exactly the shape
      // `preserveHeadOnStaleRead` reads as "the incoming payload is newer",
      // so the next cache-lagged list body would be allowed to rewind
      // `head_sha` — and `isTrustedHeadShaMove` would then supersede the
      // walkthrough generating at the real head. GitHub bumped its own
      // `updated_at` on this push and `PrMeta` doesn't carry it, so stamp
      // now: at worst a few seconds ahead of GitHub's value, which errs
      // toward rejecting stale reads rather than accepting them.
      const updatedAt = headSha === fresh.headSha ? fresh.updatedAt : now;
      yield* prService
        .upsertPrs([
          {
            ...fresh,
            stack: STACK_UNSEEN,
            headSha,
            updatedAt,
            fetchedAt: now,
          },
        ])
        .pipe(Effect.catch(() => Effect.void));
    });

  const broadcastPrsUpdated = (prId: string) =>
    Effect.gen(function* () {
      const pr = yield* prService.getPr(prId);
      const accountId = yield* prCtx.getAccountIdForRepo(pr.repositoryId);
      const prs = yield* prService.listPrs(accountId);
      yield* broadcaster.broadcastToAccount(accountId, {
        type: "prs:updated",
        data: prs,
      });
    });

  return { recordPushedHead, broadcastPrsUpdated };
};
