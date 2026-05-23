// ── Recap SSE stream ────────────────────────────────────────────────────────
//
// GET /api/recaps/:id/stream — SSE endpoint for live recap generation.
//
// Thin subscriber around {@link ProjectRecapJobs}. Mirrors the walkthrough
// SSE handler pattern but radically simpler:
//   • No SSR pre-render.
//   • No clone polling.
//   • Reconnect emits the current `lede` + each `entry` snapshot from the
//     DB, then attaches to live events if the job is still running.
//   • Legacy fallback: when there's no structured data but `overview`
//     markdown is present (pre-rewrite recap), an `overview` event is
//     emitted so the legacy markdown renderer still works.

import type { ProjectRecapStatus } from "@revv/shared";
import { Effect } from "effect";
import { AppRuntime } from "../../runtime";
import { ProjectRecapService } from "../../services/ProjectRecap";
import { ProjectRecapJobs } from "../../services/ProjectRecapJobs";
import { createSseStream, sseHeaders } from "../reviews/sse";

function emitSnapshot(
  writer: { send: (event: import("@revv/shared").RecapStreamEvent) => void },
  row: import("@revv/shared").ProjectRecap,
): void {
  if (row.lede) {
    writer.send({ type: "lede", data: { lede: row.lede } });
  }
  for (const entry of row.entries) {
    writer.send({ type: "entry", data: { entry } });
  }
  for (const summary of row.themeSummaries) {
    writer.send({ type: "theme_summary", data: { summary } });
  }
}

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
        emitSnapshot(writer, row);
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
        if (finalRow.status === "complete") {
          emitSnapshot(writer, finalRow);
          writer.send({ type: "done", data: { recapId: finalRow.id } });
        } else if (finalRow.status === "error") {
          writer.send({
            type: "error",
            data: {
              code: "RecapGenerationError",
              message: finalRow.errorMessage ?? "Recap generation failed",
            },
          });
        }
        writer.close();
        return;
      }

      onCancel(sub.unsubscribe);

      // Flush buffered events (delivered through the subscriber callback
      // in arrival order) BEFORE reading the snapshot. Then re-read the
      // row so any writes committed between phase 1 and now are reflected
      // in the replay snapshot.
      sub.flush();

      const snapshot = await AppRuntime.runPromise(
        Effect.flatMap(ProjectRecapService, (s) => s.getById(ctx.params.id)),
      ).catch(() => row);

      emitSnapshot(writer, snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writer.send({ type: "error", data: { code: "SetupError", message } });
      writer.close();
    }
  })();

  return new Response(stream, { headers: sseHeaders });
}
