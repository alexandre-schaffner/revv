// ─── WalkthroughSnapshotImporter ─────────────────────────────────────────────
//
// Bulk hydrate a `walkthroughs` row family from a remote-cache snapshot.
// Mirrors the end-state contract of a compliant agent run on another
// machine, but in a single transaction.
//
// Per CLAUDE.md "Agent Subsystem Invariants":
//   • #2 — agent content writes go through MCP. An importer is not an
//          agent; this is a deterministic bulk hydrate of content that
//          was already produced by a validated agent run elsewhere.
//   • #4 — strict 4-phase pipeline. We assert phase outputs before the
//          txn and stamp `lastCompletedPhase='D'` inside it.
//   • #7 — walkthroughs immutable per head SHA. We only ever import into
//          a partial row at `(prId, headSha)`; status='complete' rows
//          are detected by the caller and skipped.
//   • #8 — commit first, broadcast second. The txn commits content +
//          attribution columns; the caller subsequently calls
//          `WalkthroughJobs.setStatus('complete')` which triggers the
//          existing ws broadcast.
//   • #11 — status transitions are orchestrator-only. The importer
//           NEVER writes `walkthroughs.status` directly.
//   • #12 — `complete_walkthrough` validation gate. We replicate the
//           same checks as a pre-import assertion.

import type { WalkthroughSnapshotV2 } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { walkthroughBlocks } from "../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../db/schema/walkthrough-issues";
import { walkthroughRatings } from "../db/schema/walkthrough-ratings";
import { walkthroughSemanticSteps } from "../db/schema/walkthrough-semantic-steps";
import { walkthroughs } from "../db/schema/walkthroughs";
import { ImportError } from "../domain/errors";
import { debug } from "../logger";
import { DbService } from "./Db";
import { validateSnapshot } from "./walkthrough-snapshot";

export class WalkthroughSnapshotImporter extends Context.Tag("WalkthroughSnapshotImporter")<
  WalkthroughSnapshotImporter,
  {
    /**
     * Hydrate a pre-created walkthrough row from a snapshot.
     *
     * The caller (`WalkthroughJobs.startJob`) is expected to:
     *   1. Call `WalkthroughService.createPartial` to obtain a partial
     *      row at `(prId, prHeadSha)`. Its `id` is what gets passed here.
     *   2. Call this importer to populate content + attribution.
     *   3. Call `WalkthroughJobs.setStatus(id, 'complete')` to fire the
     *      lifecycle transition and ws broadcast.
     *
     * If validation fails or the row is in an unimportable state, the
     * caller falls back to running the agent normally — no half-imported
     * rows ever exist (the whole population happens in one transaction).
     */
    readonly import: (params: {
      readonly walkthroughId: string;
      readonly snapshot: WalkthroughSnapshotV2;
    }) => Effect.Effect<void, ImportError, DbService>;
  }
>() {}

export const WalkthroughSnapshotImporterLive = Layer.succeed(WalkthroughSnapshotImporter, {
  import: ({ walkthroughId, snapshot }) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;

      // Pre-flight validation — same gate as `complete_walkthrough`.
      const v = validateSnapshot(snapshot);
      if (!v.ok) {
        return yield* Effect.fail(
          new ImportError({
            walkthroughId,
            reason: `validation failed: ${v.reason}`,
          }),
        );
      }

      yield* Effect.try({
        try: () =>
          db.transaction(() => {
            // Confirm the target row exists and is in a state we can fill.
            // We tolerate `generating` (the normal post-createPartial case)
            // and abort on every other status — `complete` would violate
            // invariant #7, `superseded` would be churn, `error` should
            // get recycled by `createPartial` not "fixed" by an import.
            const row = db
              .select({ id: walkthroughs.id, status: walkthroughs.status })
              .from(walkthroughs)
              .where(eq(walkthroughs.id, walkthroughId))
              .get();
            if (!row) {
              throw new Error(`walkthrough row ${walkthroughId} not found`);
            }
            if (row.status !== "generating") {
              throw new Error(
                `walkthrough row ${walkthroughId} status=${row.status} — refusing to overwrite`,
              );
            }

            // Wipe any partial child rows so a re-imported snapshot doesn't
            // collide with leftovers from an interrupted agent run.
            db.delete(walkthroughBlocks)
              .where(eq(walkthroughBlocks.walkthroughId, walkthroughId))
              .run();
            db.delete(walkthroughIssues)
              .where(eq(walkthroughIssues.walkthroughId, walkthroughId))
              .run();
            db.delete(walkthroughRatings)
              .where(eq(walkthroughRatings.walkthroughId, walkthroughId))
              .run();
            db.delete(walkthroughSemanticSteps)
              .where(eq(walkthroughSemanticSteps.walkthroughId, walkthroughId))
              .run();

            // ── Phase A + C: content lives on the row ────────────────────
            // `summary` + `riskLevel` are Phase A outputs; `sentiment` is
            // Phase C. We do NOT touch `status` (invariant #11). We DO
            // stamp `lastCompletedPhase='D'` because the importer is
            // equivalent to having finished all four phases.
            const nowIso = new Date().toISOString();
            db.update(walkthroughs)
              .set({
                summary: snapshot.summary,
                riskLevel: snapshot.riskLevel,
                sentiment: snapshot.sentiment,
                lastCompletedPhase: "D",
                modelUsed: snapshot.modelUsed,
                tokenUsage: JSON.stringify(snapshot.tokenUsage),
                generatedByGithubUserId: snapshot.generatedBy.githubUserId,
                generatedByGithubLogin: snapshot.generatedBy.githubLogin,
                generatedByDisplayName: snapshot.generatedBy.displayName,
                generatedByAvatarUrl: snapshot.generatedBy.avatarContent,
                providerConfig: JSON.stringify(snapshot.providerConfig),
              })
              .where(eq(walkthroughs.id, walkthroughId))
              .run();

            // ── Phase B: semantic steps + blocks ─────────────────────────
            // Insert semantic steps first so child blocks have parents
            // matching the application-level FK convention.
            for (const step of snapshot.semanticSteps) {
              db.insert(walkthroughSemanticSteps)
                .values({
                  id: crypto.randomUUID(),
                  walkthroughId,
                  semanticStepIndex: step.index,
                  title: step.title,
                  summary: step.summary,
                  createdAt: nowIso,
                })
                .run();
            }

            // Insert blocks in declaration order; capture new ids so
            // issues + ratings can re-link via their `blockIndexes`.
            const newBlockIds: string[] = [];
            for (let i = 0; i < snapshot.blocks.length; i++) {
              const b = snapshot.blocks[i];
              if (!b) continue;
              const id = crypto.randomUUID();
              newBlockIds.push(id);

              // The block payload (`data`) still carries the *source*
              // machine's block id internally — but that id is purely a
              // labelling artifact for the renderer; the durable
              // linkage uses (semanticStepIndex, stepIndex). Rewrite
              // it to the new local id so the renderer's id-anchors
              // (e.g. issue-card links) line up.
              const dataWithLocalId = { ...b.data, id };

              db.insert(walkthroughBlocks)
                .values({
                  id,
                  walkthroughId,
                  phase: b.phase,
                  semanticStepIndex: b.semanticStepIndex,
                  order: b.semanticStepIndex * 10000 + b.stepIndex,
                  stepIndex: b.stepIndex,
                  type: b.type,
                  data: JSON.stringify(dataWithLocalId),
                  createdAt: nowIso,
                })
                .run();
            }

            // ── Issues ──────────────────────────────────────────────────
            // Snapshots NEVER contain submittedAt-marked issues (exporter
            // filters them out). Importer sets submittedAt=null verbatim.
            for (const issue of snapshot.issues) {
              const blockIds = issue.blockIndexes
                .map((idx) => newBlockIds[idx])
                .filter((id): id is string => typeof id === "string");
              db.insert(walkthroughIssues)
                .values({
                  id: crypto.randomUUID(),
                  walkthroughId,
                  order: issue.order,
                  severity: issue.severity,
                  title: issue.title,
                  description: issue.description,
                  filePath: issue.filePath,
                  startLine: issue.startLine,
                  endLine: issue.endLine,
                  blockIds: JSON.stringify(blockIds),
                  createdAt: nowIso,
                  submittedAt: null,
                })
                .run();
            }

            // ── Phase D: ratings ────────────────────────────────────────
            for (const rating of snapshot.ratings) {
              const blockIds = rating.blockIndexes
                .map((idx) => newBlockIds[idx])
                .filter((id): id is string => typeof id === "string");
              db.insert(walkthroughRatings)
                .values({
                  id: crypto.randomUUID(),
                  walkthroughId,
                  axis: rating.axis,
                  verdict: rating.verdict,
                  confidence: rating.confidence,
                  rationale: rating.rationale,
                  details: rating.details,
                  citations: JSON.stringify(rating.citations),
                  blockIds: JSON.stringify(blockIds),
                  createdAt: nowIso,
                })
                .run();
            }
          }),
        catch: (cause) =>
          new ImportError({
            walkthroughId,
            reason: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

      debug(
        "snapshot-importer",
        `imported wt=${walkthroughId} blocks=${snapshot.blocks.length} ratings=${snapshot.ratings.length} issues=${snapshot.issues.length}`,
      );
    }),
});
