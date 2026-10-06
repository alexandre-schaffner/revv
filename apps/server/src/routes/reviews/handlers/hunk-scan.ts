import type { HunkScanEnsureResult } from "@revv/shared";
import { Effect } from "effect";
import { filePriorityOrder, resolveJobStartAnswers } from "../../../ai/jev/job-start";
import { AppRuntime } from "../../../runtime";
import { HunkScanService } from "../../../services/HunkScan";
import { JevService } from "../../../services/Jev";
import { loadCachedPrDiff } from "./cached-pr-diff";

/**
 * POST /api/reviews/:id/hunk-scan
 *
 * The first pass for the PR's current head, started unless it is running or
 * done, and returned as persisted. Called when the review page has loaded the
 * diff; rows then stream in as `hunk-scan:*` events. Every ask goes through
 * `start`, which retries a `failed` or `partial` scan and rebuilds one seeded
 * from a diff that has since changed.
 *
 * Like the sizing preview, it reads the cached diff only and reports `pending`
 * until the diff lands. File tiers come from the same cached job-start answer
 * the sizing preview and the walkthrough use, so generated files are skipped
 * and the important ones go first.
 */
export function ensureHunkScanHandler(prId: string, userId: string): Promise<HunkScanEnsureResult> {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const jev = yield* JevService;
      if (!(yield* jev.isAvailable())) return { status: "off" as const };

      const diff = yield* loadCachedPrDiff(prId, userId);
      if (diff === null) return { status: "pending" as const };
      const { pr, headSha, files } = diff;

      const answers = yield* resolveJobStartAnswers(pr.id, headSha, { pr, files, commits: [] });
      const hunkScan = yield* HunkScanService;
      yield* hunkScan.start({
        prId: pr.id,
        headSha,
        files,
        filePriorities: answers === null ? null : filePriorityOrder(answers, files),
      });
      return { status: "ready" as const, scan: yield* hunkScan.snapshot(pr.id, headSha) };
    }),
  );
}
