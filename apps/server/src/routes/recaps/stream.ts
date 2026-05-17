// ── Recap SSE stream ────────────────────────────────────────────────────────
//
// GET /api/recaps/:id/stream — SSE endpoint for live recap generation.
//
// Thin subscriber around {@link ProjectRecapJobs}. Mirrors the walkthrough
// SSE handler pattern but radically simpler:
//   • No SSR pre-render (recap is plain markdown).
//   • No clone polling.
//   • Reconnect reads the current DB overview as a single chunk, then
//     attaches to live events if the job is still running.

import type { ProjectRecapStatus } from "@revv/shared";
import { Effect } from "effect";
import { AppRuntime } from "../../runtime";
import { ProjectRecapService } from "../../services/ProjectRecap";
import { ProjectRecapJobs } from "../../services/ProjectRecapJobs";
import { createSseStream, sseHeaders } from "../reviews/sse";

/**
 * GET /api/recaps/:id/stream — SSE streaming recap.
 *
 * Handler pattern:
 *   1. Read the recap row.
 *   2. If complete → emit overview + done, close.
 *   3. If error    → emit error, close.
 *   4. If generating → ensure job is running, subscribe (buffered),
 *      emit current overview as initial chunk if non-empty,
 *      flush buffer, forward live events until done/error/close.
 */
export function recapStreamHandler(ctx: { params: { id: string } }): Response {
  const { stream, writer, stopHeartbeat, onCancel } = createSseStream();
  onCancel(() => stopHeartbeat());

  void (async () => {
    try {
      // Phase 1: Read recap row.
      const row = await AppRuntime.runPromise(
        Effect.flatMap(ProjectRecapService, (s) => s.getById(ctx.params.id)),
      );

      const status = row.status as ProjectRecapStatus;

      // Terminal: complete.
      if (status === "complete") {
        if (row.overview) {
          writer.send({ type: "overview", data: { overview: row.overview } });
        }
        writer.send({ type: "done", data: { recapId: row.id } });
        writer.sendDone();
        return;
      }

      // Terminal: error.
      if (status === "error") {
        writer.send({
          type: "error",
          data: {
            code: "RecapGenerationError",
            message: row.errorMessage ?? "Recap generation failed",
          },
        });
        writer.close();
        return;
      }

      // Terminal: superseded.
      if (status === "superseded") {
        writer.send({
          type: "error",
          data: { code: "Superseded", message: "This recap has been superseded." },
        });
        writer.close();
        return;
      }

      // Live: generating.
      // Ensure the job is running (idempotent — startJob reuses existing).
      const started = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const jobs = yield* ProjectRecapJobs;
          // We need the period boundaries from the row to start/resume.
          return yield* jobs.startJob({
            recapId: row.id,
            repoId: row.repositoryId,
            period: row.period,
            periodStart: row.periodStart,
            periodEnd: row.periodEnd,
            trigger: "manual",
          });
        }),
      ).catch(() => null);

      if (!started) {
        writer.send({
          type: "error",
          data: { code: "StartFailed", message: "Could not start or attach to recap job." },
        });
        writer.close();
        return;
      }

      // Subscribe in buffered mode BEFORE reading the DB snapshot.
      const sub = await AppRuntime.runPromise(
        Effect.flatMap(ProjectRecapJobs, (jobs) =>
          jobs.subscribe(row.id, (event) => {
            writer.send(event);
            if (event.type === "done" || event.type === "error") {
              writer.close();
            }
          }),
        ),
      );

      if (!sub.found) {
        // Job finished between startJob and subscribe.
        // Re-read the row to get final state.
        const finalRow = await AppRuntime.runPromise(
          Effect.flatMap(ProjectRecapService, (s) => s.getById(ctx.params.id)),
        );
        if (finalRow.status === "complete" && finalRow.overview) {
          writer.send({ type: "overview", data: { overview: finalRow.overview } });
        } else if (finalRow.status === "error") {
          writer.send({
            type: "error",
            data: {
              code: "RecapGenerationError",
              message: finalRow.errorMessage ?? "Recap generation failed",
            },
          });
        }
        if (finalRow.status === "complete") {
          writer.send({ type: "done", data: { recapId: finalRow.id } });
        }
        writer.close();
        return;
      }

      onCancel(sub.unsubscribe);

      // Flush the buffer (drains pre-subscribe events through the callback,
      // then switches to direct-forward mode) BEFORE reading the snapshot.
      // This way any chunk emitted during the snapshot read fires
      // synchronously to the wire, and the snapshot is sent as a single
      // authoritative `overview` event that replaces client state — no
      // duplication regardless of inter-leaving.
      sub.flush();

      // Re-read the row after subscribing/flushing so any chunks committed
      // between phase 1 and now are reflected in the snapshot.
      const snapshot = await AppRuntime.runPromise(
        Effect.flatMap(ProjectRecapService, (s) => s.getById(ctx.params.id)),
      ).catch(() => row);

      // Replay DB snapshot as an `overview` event (replaces client state)
      // rather than `chunk` (which appends). On reconnect with surviving
      // client state, appending duplicates the overview text.
      if (snapshot.overview && snapshot.overview.length > 0) {
        writer.send({ type: "overview", data: { overview: snapshot.overview } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writer.send({ type: "error", data: { code: "SetupError", message } });
      writer.close();
    }
  })();

  return new Response(stream, { headers: sseHeaders });
}
