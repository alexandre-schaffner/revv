import { isMergeStateSettling, type MergeEligibility } from "@revv/shared";
import { Effect } from "effect";
import type { GitHubError } from "../domain/errors";
import { keyedSingleFlight } from "../effects/keyed-single-flight";
import { logError } from "../logger";
import { withGitHubOrigin } from "../observability/github-ledger/origin";
import { GitHubGateway } from "./github/gateway";
import type { GitHubClient } from "./github/transport";
import { Realtime } from "./Realtime";

/**
 * GitHub computes mergeability lazily after a push and answers `UNKNOWN`
 * meanwhile, without announcing the result. The server asks again on this
 * schedule and announces the outcome either way.
 */
const SETTLE_DELAYS_MS = [3_000, 3_000, 3_000, 3_000];

interface MergeTarget {
  readonly prId: string;
  readonly repoFullName: string;
  readonly prNumber: number;
}

const settleOnce = keyedSingleFlight<string, void, never>();

const settle = (target: MergeTarget, client: GitHubClient) =>
  settleOnce(
    target.prId,
    Effect.gen(function* () {
      const github = yield* GitHubGateway;
      const realtime = yield* Realtime;
      let eligibility: MergeEligibility | null = null;
      for (const delay of SETTLE_DELAYS_MS) {
        yield* Effect.sleep(delay);
        eligibility = yield* github.prs
          .mergeEligibility(client, target.repoFullName, target.prNumber)
          .pipe(
            Effect.catch((e) =>
              Effect.sync(() => {
                logError("merge-eligibility", `settling ${target.prId} failed:`, e);
                return null;
              }),
            ),
          );
        if (eligibility === null || !isMergeStateSettling(eligibility.mergeStateStatus)) break;
      }
      if (eligibility === null) return;
      yield* realtime.toPr(target.prId, {
        type: "pr:merge-eligibility",
        data: { prId: target.prId, eligibility },
      });
    }).pipe(withGitHubOrigin("merge-eligibility:settle")),
  );

/**
 * Whether the viewer can merge the PR, now. An answer GitHub is still
 * computing comes back as is, and the settled one follows as
 * `pr:merge-eligibility`.
 */
export const checkMergeEligibility = (
  target: MergeTarget,
  client: GitHubClient,
): Effect.Effect<MergeEligibility, GitHubError, GitHubGateway | Realtime> =>
  Effect.gen(function* () {
    const github = yield* GitHubGateway;
    const eligibility = yield* github.prs.mergeEligibility(
      client,
      target.repoFullName,
      target.prNumber,
    );
    if (isMergeStateSettling(eligibility.mergeStateStatus)) {
      yield* Effect.forkDetach(settle(target, client));
    }
    return eligibility;
  });
