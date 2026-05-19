import type {
  CodeBlock,
  DiffBlock,
  WalkthroughBlock,
  WalkthroughPipelinePhase,
  WalkthroughStreamEvent,
} from "@revv/shared";
import { Effect } from "effect";
import { debug, logError } from "../../../logger";
import { AppRuntime } from "../../../runtime";
import { GitHubService } from "../../../services/GitHub";
import { PrContextService } from "../../../services/PrContext";
import {
  prerenderDiff,
  prerenderFile,
  type SsrDiffOptions,
  type SsrFileOptions,
} from "../../../services/PrerenderCache";
import { WalkthroughService } from "../../../services/Walkthrough";
import { WalkthroughJobs } from "../../../services/WalkthroughJobs";
import { unwrapEffectError } from "../../middleware";
import { createSseStream, sseHeaders } from "../sse";

// ── SSR options ─────────────────────────────────────────────────────────────
//
// These structural options must match the FileDiff / File constructor
// options on the client (WalkthroughDiffBlock.svelte / WalkthroughCodeBlock.svelte)
// so the SSR HTML hydrates byte-for-byte cleanly. Drift here = broken hydrate.

const WALKTHROUGH_DIFF_SSR_OPTIONS: SsrDiffOptions = {
  diffStyle: "unified",
  theme: { dark: "pierre-dark", light: "pierre-light" },
  overflow: "scroll",
  disableFileHeader: true,
};

const WALKTHROUGH_CODE_SSR_OPTIONS: SsrFileOptions = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
  overflow: "scroll",
  disableFileHeader: true,
};

/** Build the git-style patch the SSR call wants from a block's bare hunks. */
function buildWalkthroughPatch(block: DiffBlock): string {
  const header = [
    `diff --git a/${block.filePath} b/${block.filePath}`,
    `--- a/${block.filePath}`,
    `+++ b/${block.filePath}`,
  ].join("\n");
  return `${header}\n${block.patch}`;
}

async function prerenderBlock(block: WalkthroughBlock): Promise<string | null> {
  if (block.type === "diff") {
    return prerenderDiff(buildWalkthroughPatch(block), WALKTHROUGH_DIFF_SSR_OPTIONS);
  }
  if (block.type === "code") {
    return prerenderFile(
      { name: block.filePath, contents: block.content, lang: block.language },
      WALKTHROUGH_CODE_SSR_OPTIONS,
    );
  }
  // Markdown blocks render as plain HTML on the client — no SSR.
  return null;
}

function needsPrerender(block: WalkthroughBlock): block is DiffBlock | CodeBlock {
  return (block.type === "diff" || block.type === "code") && block.prerenderedHtml === undefined;
}

/** Monotonic ordering for phase:advanced dedupe. */
const PHASE_RANK: Record<WalkthroughPipelinePhase, number> = {
  none: 0,
  A: 1,
  B: 2,
  C: 3,
  D: 4,
};

/**
 * GET /api/reviews/:id/walkthrough — SSE streaming walkthrough.
 *
 * Thin subscriber around {@link WalkthroughJobs}. The durable generation
 * fiber lives in the service; this handler just:
 *   1. Resolves PR + headSha (lightweight — no diff).
 *   2. Serves a fully-cached walkthrough inline if one exists for that sha.
 *   3. Finds or starts the active job for the PR.
 *   4. Subscribes (in buffering mode) to the job's live event stream.
 *   5. Replays the DB snapshot through the same dedupe-aware forwarder.
 *      When `snapshotAt` + `lastPhase` cursor params are present (client
 *      already hydrated from `/current`), replay is cursor-filtered:
 *        - Top-level events (summary, sentiment, phase:advanced) are
 *          skipped based on `lastPhase` rank.
 *        - Child-table rows are queried with `createdAt > snapshotAt` so
 *          only race-window rows (created between the REST call and the SSE
 *          subscription) arrive over the wire.
 *   6. Flushes the subscriber's buffer — any events that arrived during
 *      the DB read now drain in order, then future events forward directly.
 *   7. Stays open until `done` / `error` closes the writer, or the client
 *      disconnects (in which case we unsubscribe but the job keeps running
 *      in the background — that's the durability story).
 *
 * Dedupe is needed because the replay+live handoff window can deliver a
 * single event from both sides: the live fanout captures it as the fiber
 * persists it, and the DB snapshot we read a moment later also returns
 * it. Seen-sets keyed by block.id / issue.id / rating.axis / summary-once
 * collapse the duplicates without dropping events that legitimately only
 * came from one path.
 */
export function walkthroughStreamHandler(ctx: {
  params: { id: string };
  session: { user: { id: string } };
  query: { snapshotAt?: string; lastPhase?: string };
}): Response {
  const { stream, writer, stopHeartbeat, onCancel } = createSseStream();

  // Cleanup: always stop the heartbeat once the client goes away or we
  // terminate the stream — the writer/stream handles both cases through
  // onCancel(), so one registration covers everything.
  onCancel(() => stopHeartbeat());

  // Cursor params from a prior /current REST call. When both are present
  // the snapshot replay is cursor-filtered: top-level events are skipped
  // based on phase rank, and child rows are filtered to createdAt > snapshotAt.
  const cursorSnapshotAt = ctx.query.snapshotAt || undefined;
  const rawLastPhase = ctx.query.lastPhase;
  const validPhases: WalkthroughPipelinePhase[] = ["none", "A", "B", "C", "D"];
  const cursorLastPhase: WalkthroughPipelinePhase | undefined =
    rawLastPhase !== undefined && validPhases.includes(rawLastPhase as WalkthroughPipelinePhase)
      ? (rawLastPhase as WalkthroughPipelinePhase)
      : undefined;
  const hasCursor = cursorSnapshotAt !== undefined && cursorLastPhase !== undefined;

  void (async () => {
    // Dedupe state for the subscribe-then-replay handoff.
    // When cursor params are present, pre-seed the seen-sets so forwardEvent
    // skips top-level events the client already received from /current.
    let seenSummary = hasCursor && PHASE_RANK[cursorLastPhase!] >= PHASE_RANK["A"];
    const seenSemanticSteps = new Set<number>();
    const seenBlocks = new Set<string>();
    const seenIssues = new Set<string>();
    const seenRatingAxes = new Set<string>();
    let seenSentiment = hasCursor && PHASE_RANK[cursorLastPhase!] >= PHASE_RANK["C"];
    let highestEmittedPhase: WalkthroughPipelinePhase = hasCursor ? cursorLastPhase! : "none";
    let terminated = false;

    // Diagnostic-only event ordinal (per-connection). Pairs with the
    // server-side `nextSeq` on ActiveJob and the client's lastSeenSeq so we
    // can correlate three vantage points: (1) what fanOut emitted,
    // (2) what this writer attempted, (3) what the client received.
    let forwardOrd = 0;
    const tracePrId = ctx.params.id;

    // Set after startJob / subscribe so the prerender failure handler can
    // increment the per-job counter (S10).
    let currentWalkthroughId: string | undefined;

    const forwardEvent = (event: WalkthroughStreamEvent): void => {
      const ord = forwardOrd++;
      if (terminated) {
        debug(
          "wt-trace",
          `forward-skip pr=${tracePrId} ord=${ord} type=${event.type} reason=terminated`,
        );
        return;
      }

      switch (event.type) {
        case "summary":
          if (seenSummary) {
            debug("wt-trace", `forward-dedupe pr=${tracePrId} ord=${ord} type=summary reason=seen`);
            return;
          }
          seenSummary = true;
          break;
        case "semantic-step":
          if (seenSemanticSteps.has(event.data.semanticStepIndex)) {
            debug(
              "wt-trace",
              `forward-dedupe pr=${tracePrId} ord=${ord} type=semantic-step idx=${event.data.semanticStepIndex} reason=seen`,
            );
            return;
          }
          seenSemanticSteps.add(event.data.semanticStepIndex);
          break;
        case "block":
          if (seenBlocks.has(event.data.id)) {
            debug(
              "wt-trace",
              `forward-dedupe pr=${tracePrId} ord=${ord} type=block id=${event.data.id} reason=seen`,
            );
            return;
          }
          seenBlocks.add(event.data.id);
          break;
        case "issue":
          if (seenIssues.has(event.data.id)) {
            debug(
              "wt-trace",
              `forward-dedupe pr=${tracePrId} ord=${ord} type=issue id=${event.data.id} reason=seen`,
            );
            return;
          }
          seenIssues.add(event.data.id);
          break;
        case "rating":
          if (seenRatingAxes.has(event.data.axis)) {
            debug(
              "wt-trace",
              `forward-dedupe pr=${tracePrId} ord=${ord} type=rating axis=${event.data.axis} reason=seen`,
            );
            return;
          }
          seenRatingAxes.add(event.data.axis);
          break;
        case "sentiment":
          if (seenSentiment) {
            debug(
              "wt-trace",
              `forward-dedupe pr=${tracePrId} ord=${ord} type=sentiment reason=seen`,
            );
            return;
          }
          seenSentiment = true;
          break;
        case "phase:advanced":
          // Monotonic: drop anything that doesn't strictly advance the
          // client past what we've already told it. Guards the replay
          // window where a live phase:advanced and the snapshot's
          // lastCompletedPhase can both arrive.
          if (PHASE_RANK[event.data.lastCompletedPhase] <= PHASE_RANK[highestEmittedPhase]) {
            debug(
              "wt-trace",
              `forward-dedupe pr=${tracePrId} ord=${ord} type=phase:advanced phase=${event.data.lastCompletedPhase} highest=${highestEmittedPhase} reason=non-monotonic`,
            );
            return;
          }
          highestEmittedPhase = event.data.lastCompletedPhase;
          break;
        default:
          break;
      }

      const ok = writer.send(event);
      debug("wt-trace", `forward-send pr=${tracePrId} ord=${ord} type=${event.type} ok=${ok}`);

      if (event.type === "done") {
        terminated = true;
        writer.sendDone();
      } else if (event.type === "error") {
        terminated = true;
        writer.close();
      }
    };

    // Async queue for SSR-augmented forwarding. Block events with type
    // 'diff' or 'code' get `prerenderedHtml` attached via the shared SSR
    // cache before they hit the wire; everything else passes through
    // untouched. Serialising through a tail-call promise chain preserves
    // strict emission order — semantic-steps still arrive before their
    // child blocks even when the SSR call yields. Prerender failures fall
    // back to emitting the original event so a broken patch never blocks
    // the stream.
    let emitQueue: Promise<void> = Promise.resolve();
    const enqueueForward = (event: WalkthroughStreamEvent): void => {
      emitQueue = emitQueue.then(async () => {
        if (terminated) return;
        let toEmit: WalkthroughStreamEvent = event;
        if (event.type === "block" && needsPrerender(event.data)) {
          try {
            const html = await prerenderBlock(event.data);
            if (html !== null) {
              toEmit = { type: "block", data: { ...event.data, prerenderedHtml: html } };
            }
          } catch (err) {
            logError(
              "walkthrough-prerender",
              `block ${event.data.id} (${event.data.type}) prerender failed:`,
              err,
            );
            const wtId = currentWalkthroughId;
            if (wtId) {
              void AppRuntime.runPromise(
                Effect.flatMap(WalkthroughJobs, (jobs) => jobs.incrementPrerenderFailures(wtId)),
              );
            }
          }
        }
        forwardEvent(toEmit);
      });
    };

    try {
      // Send the first phase synchronously so the client UI unblocks
      // immediately while we do the setup dance below.
      if (!writer.sendPhase("connecting", "Connecting...")) return;

      // ── Step 1: Resolve PR basics + headSha (no diff fetch) ──────
      // Diff fetch happens inside WalkthroughJobs.startJob, so if we
      // short-circuit on cache we never paid for it.
      if (!writer.sendPhase("connecting", "Fetching PR details...")) return;

      const resolved = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const prContext = yield* PrContextService;
          const github = yield* GitHubService;
          const basic = yield* prContext.resolveBasic(ctx.params.id, ctx.session.user.id);
          const meta = yield* github.getPrMeta(
            basic.repo.fullName,
            basic.pr.externalId,
            basic.token,
          );
          return { prId: basic.pr.id, headSha: meta.headSha };
        }),
      );

      // ── Step 2: Cache hit? Replay inline and terminate. ──────────
      const cached = await AppRuntime.runPromise(
        Effect.flatMap(WalkthroughService, (s) => s.getCached(resolved.prId, resolved.headSha)),
      );
      if (cached) {
        enqueueForward({
          type: "summary",
          data: { summary: cached.summary, riskLevel: cached.riskLevel },
        });
        // Semantic steps must be replayed BEFORE their child blocks so
        // the client's `WalkthroughSection` parents exist by the time
        // the block events land.
        for (const section of cached.semanticSteps) {
          enqueueForward({ type: "semantic-step", data: section });
        }
        for (const block of cached.blocks) enqueueForward({ type: "block", data: block });
        for (const issue of cached.issues) enqueueForward({ type: "issue", data: issue });
        for (const rating of cached.ratings) enqueueForward({ type: "rating", data: rating });
        // Sentiment is a first-class walkthrough field; without this
        // replay, SSE-reconnects to a cached row render the blocks +
        // ratings but lose the "Overall Sentiment" card that the JSON
        // hydration path (hydrateFromCache) correctly surfaces.
        if (cached.sentiment !== null) {
          enqueueForward({ type: "sentiment", data: { sentiment: cached.sentiment } });
        }
        // status='complete' implies lastCompletedPhase='D' (the orchestrator's
        // validation gate). Without this replay, a client that re-streams a
        // completed walkthrough (e.g. after a WS `walkthrough:complete` races
        // ahead of the live `done` event and triggers fetchCachedWalkthrough)
        // ends up with lastCompletedPhase='none', leaving the floating-bar
        // UI state stuck in 'resumable' (Resume + Regenerate) instead of
        // 'complete' (Regenerate only). See walkthrough-ui-state.svelte.ts.
        enqueueForward({
          type: "phase:advanced",
          data: { lastCompletedPhase: cached.lastCompletedPhase },
        });
        // ── Defense-in-depth: re-validate invariant #12 before emitting `done`.
        // The orchestrator is supposed to gate `status='complete'` on these checks,
        // but if a corrupt / partially-written row somehow got through, we catch it
        // here so the client doesn't receive a `done` on incomplete data.
        const invariantFailures: string[] = [];
        if (cached.lastCompletedPhase !== "D") {
          invariantFailures.push(
            `lastCompletedPhase='${cached.lastCompletedPhase}' (expected 'D')`,
          );
        }
        if (!cached.summary || cached.summary.trim().length === 0) {
          invariantFailures.push("summary empty");
        }
        if (!cached.sentiment || cached.sentiment.trim().length === 0) {
          invariantFailures.push("sentiment empty");
        }
        if (cached.semanticSteps.length === 0) {
          invariantFailures.push("no semantic steps");
        }
        if (cached.ratings.length !== 9) {
          invariantFailures.push(`ratings=${cached.ratings.length} (expected 9)`);
        }
        if (invariantFailures.length > 0) {
          logError(
            "wt-trace",
            `cached-replay invariant #12 failed walkthrough=${cached.id}:`,
            invariantFailures.join("; "),
          );
          enqueueForward({
            type: "error",
            data: {
              code: "INVARIANT_VIOLATION",
              message: `Walkthrough data incomplete: ${invariantFailures.join(", ")}.`,
            },
          });
          // Still emit done so the client stream terminates, but the preceding
          // error event tells the UI to show a failure state.
        }
        enqueueForward({
          type: "done",
          data: { walkthroughId: cached.id, tokenUsage: cached.tokenUsage },
        });
        return;
      }

      // ── Step 3: Find the live job, or start one. ─────────────────
      if (!writer.sendPhase("connecting", "Starting AI analysis...")) return;

      const { walkthroughId } = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const jobs = yield* WalkthroughJobs;
          const existing = yield* jobs.findActiveByPr(resolved.prId);
          if (existing !== null && existing.prHeadSha === resolved.headSha) {
            return { walkthroughId: existing.walkthroughId };
          }
          return yield* jobs.startJob({
            prId: resolved.prId,
            userId: ctx.session.user.id,
            trigger: "user",
          });
        }),
      );
      currentWalkthroughId = walkthroughId;

      // ── Step 4: Subscribe in buffering mode BEFORE the DB read. ──
      // The buffer captures events arriving during steps 4–6 so we
      // can replay them in order after the snapshot, and THEN switch
      // to direct-forward mode.
      const sub = await AppRuntime.runPromise(
        Effect.flatMap(WalkthroughJobs, (jobs) => jobs.subscribe(walkthroughId, enqueueForward)),
      );

      if (!sub.found) {
        // Job finished between startJob and subscribe (e.g. tiny
        // cached repos complete in milliseconds). Read the final
        // state from the DB and replay as a terminal sequence.
        const finalState = await AppRuntime.runPromise(
          Effect.flatMap(WalkthroughService, (s) => s.getCached(resolved.prId, resolved.headSha)),
        );
        if (finalState) {
          // status='complete' from getCached implies Phase D was
          // reached, so summary / sentiment / lastCompletedPhase are
          // all guaranteed populated — no empty-string guard needed.
          enqueueForward({
            type: "summary",
            data: { summary: finalState.summary, riskLevel: finalState.riskLevel },
          });
          for (const section of finalState.semanticSteps) {
            enqueueForward({ type: "semantic-step", data: section });
          }
          for (const block of finalState.blocks) enqueueForward({ type: "block", data: block });
          for (const issue of finalState.issues) enqueueForward({ type: "issue", data: issue });
          for (const rating of finalState.ratings) enqueueForward({ type: "rating", data: rating });
          if (finalState.sentiment !== null) {
            enqueueForward({
              type: "sentiment",
              data: { sentiment: finalState.sentiment },
            });
          }
          enqueueForward({
            type: "phase:advanced",
            data: { lastCompletedPhase: finalState.lastCompletedPhase },
          });
          enqueueForward({
            type: "done",
            data: { walkthroughId: finalState.id, tokenUsage: finalState.tokenUsage },
          });
          return;
        }
        // No cached row either — the job must have errored. Fall
        // back to the partial (which may now be marked error).
        const partial = await AppRuntime.runPromise(
          Effect.flatMap(WalkthroughService, (s) => s.getPartial(resolved.prId, resolved.headSha)),
        );
        if (partial) {
          // Partial may be from a very early failure (placeholder
          // summary written at createPartial, Phase A never ran).
          // Guard the empty string so the client gets a clean
          // empty-state → error transition instead of a bogus
          // summary=''.
          if (partial.summary !== "") {
            enqueueForward({
              type: "summary",
              data: { summary: partial.summary, riskLevel: partial.riskLevel },
            });
          }
          for (const section of partial.semanticSteps) {
            enqueueForward({ type: "semantic-step", data: section });
          }
          for (const block of partial.blocks) enqueueForward({ type: "block", data: block });
          for (const issue of partial.issues) enqueueForward({ type: "issue", data: issue });
          for (const rating of partial.ratings) enqueueForward({ type: "rating", data: rating });
          if (partial.sentiment !== null) {
            enqueueForward({
              type: "sentiment",
              data: { sentiment: partial.sentiment },
            });
          }
          if (partial.lastCompletedPhase !== "none") {
            enqueueForward({
              type: "phase:advanced",
              data: { lastCompletedPhase: partial.lastCompletedPhase },
            });
          }
          enqueueForward({
            type: "error",
            data: { code: "AiGenerationError", message: "Walkthrough generation failed" },
          });
          return;
        }
        // Nothing to replay — surface a generic error so the UI
        // doesn't hang on the phase message.
        enqueueForward({
          type: "error",
          data: {
            code: "NotFound",
            message: "Walkthrough job ended before we could subscribe",
          },
        });
        return;
      }

      // Auto-unsubscribe on client disconnect so the job's subscriber
      // set doesn't accumulate dead handles across re-connects.
      onCancel(sub.unsubscribe);

      // ── Step 5: Replay the DB snapshot through forwardEvent ──────
      // When cursor params are present (client already hydrated from
      // /current), we do a cursor-filtered replay: skip top-level events
      // whose phase is already covered by cursorLastPhase (handled by the
      // pre-seeded seen-sets above), and query only child rows created after
      // cursorSnapshotAt so the race window gets bridged without resending
      // the full snapshot. When no cursor, full replay as before.
      if (hasCursor) {
        // Child rows created in the race window between /current and now.
        const newRows = await AppRuntime.runPromise(
          Effect.flatMap(WalkthroughService, (s) =>
            s.getChildRowsSince(currentWalkthroughId!, cursorSnapshotAt!),
          ),
        );
        for (const section of newRows.semanticSteps) {
          enqueueForward({ type: "semantic-step", data: section });
        }
        for (const block of newRows.blocks) enqueueForward({ type: "block", data: block });
        for (const issue of newRows.issues) enqueueForward({ type: "issue", data: issue });
        for (const rating of newRows.ratings) enqueueForward({ type: "rating", data: rating });
      } else {
        const snapshot = await AppRuntime.runPromise(
          Effect.flatMap(WalkthroughService, (s) => s.getPartial(resolved.prId, resolved.headSha)),
        );
        if (snapshot) {
          // Guard against replaying the placeholder summary written at
          // `createPartial` (empty string, riskLevel='low'). If Phase A
          // hasn't committed yet, the real summary event is still in the
          // buffered queue — replaying '' here would mark seenSummary and
          // cause the flushed real event to be dropped, leaving the client
          // with a permanently-falsy summary and no content view.
          if (snapshot.summary !== "") {
            enqueueForward({
              type: "summary",
              data: { summary: snapshot.summary, riskLevel: snapshot.riskLevel },
            });
          }
          for (const section of snapshot.semanticSteps) {
            enqueueForward({ type: "semantic-step", data: section });
          }
          for (const block of snapshot.blocks) enqueueForward({ type: "block", data: block });
          for (const issue of snapshot.issues) enqueueForward({ type: "issue", data: issue });
          for (const rating of snapshot.ratings) enqueueForward({ type: "rating", data: rating });
          // Sentiment and pipeline phase are first-class walkthrough fields
          // that weren't previously replayed — a client reconnecting after
          // Phase C/D would never catch up. Replayed through forwardEvent
          // so the matching live events in the buffered queue dedupe.
          if (snapshot.sentiment !== null) {
            enqueueForward({
              type: "sentiment",
              data: { sentiment: snapshot.sentiment },
            });
          }
          if (snapshot.lastCompletedPhase !== "none") {
            enqueueForward({
              type: "phase:advanced",
              data: { lastCompletedPhase: snapshot.lastCompletedPhase },
            });
          }
        }
      }

      // ── Step 6: Drain the buffer, switch to direct-forward mode. ─
      // After this call, forwardEvent runs synchronously as events
      // arrive from the job's fanout. The stream stays open until
      // the fanout delivers `done` / `error`, or the client
      // disconnects.
      sub.flush();
      debug("walkthrough-sse", "subscribed + replayed — waiting for live events");
    } catch (err) {
      logError("walkthrough-sse", "handler error:", err);
      const e = unwrapEffectError(err);
      // Check for clone-in-progress — send special code with repoId so
      // the UI can show a progress bar and auto-retry when ready.
      if (
        e != null &&
        typeof e === "object" &&
        "_tag" in e &&
        (e as { _tag: string })._tag === "CloneInProgressError"
      ) {
        const cloneErr = e as Record<string, unknown>;
        enqueueForward({
          type: "error",
          data: {
            code: "CloneInProgress",
            message: "Repository is being cloned",
            repoId: typeof cloneErr.repoId === "string" ? cloneErr.repoId : "",
          },
        });
      } else {
        const message = e instanceof Error ? e.message : "Walkthrough connection failed";
        enqueueForward({
          type: "error",
          data: { code: "SetupError", message },
        });
      }
    }
  })();

  return new Response(stream, { headers: sseHeaders });
}
