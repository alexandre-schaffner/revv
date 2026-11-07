// Hydrates a walkthrough's content from a snapshot — a team-cache hit or a
// restack carry — in one transaction, as if a compliant agent run had written
// it. Not an agent write (invariant 2): the content was produced and gated by
// an agent run elsewhere. It never writes `status` (invariant 11); the caller
// completes the row after the commit (invariant 8). Rows get the ids the MCP
// tools derive, so chat edits address imported content like generated content.

import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { walkthroughBlocks } from "../../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import { walkthroughLeads } from "../../db/schema/walkthrough-leads";
import { walkthroughRatings } from "../../db/schema/walkthrough-ratings";
import { walkthroughSemanticSteps } from "../../db/schema/walkthrough-semantic-steps";
import { walkthroughs } from "../../db/schema/walkthroughs";
import { ImportError } from "../../domain/errors";
import { debug } from "../../logger";
import { DbService } from "../Db";
import type { WalkthroughSnapshotV2 } from "./cache-format";
import { blockId, blockOrder, issueId, normalizeProviderConfig, semanticStepId } from "./content";
import { validateSnapshot } from "./snapshot";

export class WalkthroughSnapshotImporter extends Context.Service<
  WalkthroughSnapshotImporter,
  {
    /**
     * Fill a `generating` row the caller created with `createRow`; the
     * caller completes it afterwards. On a failure (validation, or a row in
     * any other state) the caller falls back to running the agent, and no
     * half-imported row exists: the fill is one transaction.
     */
    readonly import: (params: {
      readonly walkthroughId: string;
      readonly snapshot: WalkthroughSnapshotV2;
    }) => Effect.Effect<void, ImportError, DbService>;
  }
>()("WalkthroughSnapshotImporter") {}

export const WalkthroughSnapshotImporterLive = Layer.succeed(WalkthroughSnapshotImporter, {
  import: ({ walkthroughId, snapshot }) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;

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
            // Only a `generating` row is filled: a complete one is immutable
            // (invariant 7), and an errored one is its run's record.
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
            // The interrupted run's leads describe a review that never
            // happened; the imported one carries none.
            db.delete(walkthroughLeads)
              .where(eq(walkthroughLeads.walkthroughId, walkthroughId))
              .run();

            const nowIso = new Date().toISOString();
            db.update(walkthroughs)
              .set({
                summary: snapshot.summary,
                riskLevel: snapshot.riskLevel,
                riskConfidence: null,
                sentiment: snapshot.sentiment,
                lastCompletedPhase: "D",
                modelUsed: snapshot.modelUsed,
                tokenUsage: JSON.stringify(snapshot.tokenUsage),
                generatedByGithubUserId: snapshot.generatedBy.githubUserId,
                generatedByGithubLogin: snapshot.generatedBy.githubLogin,
                generatedByDisplayName: snapshot.generatedBy.displayName,
                generatedByAvatarContent: snapshot.generatedBy.avatarContent,
                providerConfig: JSON.stringify(
                  normalizeProviderConfig(snapshot.providerConfig, snapshot.modelUsed),
                ),
                leadsSelectedAt: null,
              })
              .where(eq(walkthroughs.id, walkthroughId))
              .run();

            for (const step of snapshot.semanticSteps) {
              db.insert(walkthroughSemanticSteps)
                .values({
                  id: semanticStepId(walkthroughId, step.index),
                  walkthroughId,
                  semanticStepIndex: step.index,
                  title: step.title,
                  summary: step.summary,
                  createdAt: nowIso,
                })
                .run();
            }

            // Issues and ratings re-link through `blockIndexes`; the payload
            // carries the source walkthrough's id, rewritten so the renderer's
            // anchors match the row.
            const newBlockIds = snapshot.blocks.map((b) => {
              const id = blockId(walkthroughId, b.semanticStepIndex, b.stepIndex);
              const order = blockOrder(b.semanticStepIndex, b.stepIndex);
              db.insert(walkthroughBlocks)
                .values({
                  id,
                  walkthroughId,
                  phase: b.phase,
                  semanticStepIndex: b.semanticStepIndex,
                  order,
                  stepIndex: b.stepIndex,
                  type: b.type,
                  data: JSON.stringify({ ...b.data, id, order }),
                  createdAt: nowIso,
                })
                .run();
              return id;
            });

            // A chat edit can retitle an issue onto another's identity, so
            // a snapshot may hold two issues that derive one id; the later
            // one is told apart by its position.
            const issueIds = new Set<string>();
            for (const [position, issue] of snapshot.issues.entries()) {
              const blockIds = issue.blockIndexes
                .map((idx) => newBlockIds[idx])
                .filter((id): id is string => typeof id === "string");
              const derived = issueId(walkthroughId, issue.title, issue.filePath, issue.startLine);
              const id = issueIds.has(derived) ? `${derived}-${position}` : derived;
              issueIds.add(id);
              db.insert(walkthroughIssues)
                .values({
                  id,
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
