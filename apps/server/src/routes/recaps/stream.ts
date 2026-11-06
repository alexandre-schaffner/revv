// ── Recap SSE stream ────────────────────────────────────────────────────────
//
// GET /api/recaps/:id/stream — SSE endpoint for live recap generation.
//
// Thin subscriber around {@link ProjectRecapJobs}. Mirrors the walkthrough
// SSE handler pattern but radically simpler:
//   • No SSR pre-render.
//   • No clone polling.
//   • Reconnect emits the current `lede` + each `entry` / theme_summary
//     snapshot from the DB, then attaches to live events if the job is
//     still running.

import type { ProjectRecap, ProjectRecapStatus, RecapStreamEvent } from "@revv/shared";
import { Effect } from "effect";
import { AppRuntime } from "../../runtime";
import { ProjectRecapService } from "../../services/ProjectRecap";
import { ProjectRecapJobs } from "../../services/ProjectRecapJobs";
import { openSse, type SseChannel } from "../sse";

function emitSnapshot(channel: SseChannel<RecapStreamEvent>, row: ProjectRecap): void {
  if (row.lede) {
    channel.send({ type: "lede", data: { lede: row.lede } });
  }
  for (const entry of row.entries) {
    channel.send({ type: "entry", data: { entry } });
  }
  for (const summary of row.themeSummaries) {
    channel.send({ type: "theme_summary", data: { summary } });
  }
}

export function recapStreamHandler(ctx: { params: { id: string } }): Response {
  const { response, channel } = openSse<RecapStreamEvent>();

  void (async () => {
    try {
      // Phase 1: Read recap row.
      const row = await AppRuntime.runPromise(
        Effect.flatMap(ProjectRecapService, (s) => s.getById(ctx.params.id)),
      );

      const status = row.status as ProjectRecapStatus;

      // Terminal: complete.
      if (status === "complete") {
        emitSnapshot(channel, row);
        channel.send({ type: "done", data: { recapId: row.id } });
        channel.done();
        return;
      }

      if (status === "stopped") {
        channel.send({ type: "stopped", data: { recapId: row.id } });
        channel.close();
        return;
      }

      // Terminal: error.
      if (status === "error") {
        channel.send({
          type: "error",
          data: {
            code: "RecapGenerationError",
            message: row.errorMessage ?? "Recap generation failed",
          },
        });
        channel.close();
        return;
      }

      // Terminal: superseded.
      if (status === "superseded") {
        channel.send({
          type: "error",
          data: { code: "Superseded", message: "This recap has been superseded." },
        });
        channel.close();
        return;
      }

      // Live: generating. Make sure a run is live — the budgeted resume when
      // the one writing this row died.
      await AppRuntime.runPromise(Effect.flatMap(ProjectRecapJobs, (jobs) => jobs.attach(row.id)));

      // Subscribe in buffered mode BEFORE reading the DB snapshot.
      const sub = await AppRuntime.runPromise(
        Effect.flatMap(ProjectRecapJobs, (jobs) =>
          jobs.subscribe(row.id, (event) => {
            channel.send(event);
            if (event.type === "done" || event.type === "stopped" || event.type === "error") {
              channel.close();
            }
          }),
        ),
      );

      if (!sub.found) {
        // No live run: it finished, or its resume was refused.
        // Re-read the row to get final state.
        const finalRow = await AppRuntime.runPromise(
          Effect.flatMap(ProjectRecapService, (s) => s.getById(ctx.params.id)),
        );
        if (finalRow.status === "complete") {
          emitSnapshot(channel, finalRow);
          channel.send({ type: "done", data: { recapId: finalRow.id } });
        } else if (finalRow.status === "stopped") {
          channel.send({ type: "stopped", data: { recapId: finalRow.id } });
        } else if (finalRow.status === "error") {
          channel.send({
            type: "error",
            data: {
              code: "RecapGenerationError",
              message: finalRow.errorMessage ?? "Recap generation failed",
            },
          });
        }
        channel.close();
        return;
      }

      channel.onClose(sub.unsubscribe);

      // Flush buffered events (delivered through the subscriber callback
      // in arrival order) BEFORE reading the snapshot. Then re-read the
      // row so any writes committed between phase 1 and now are reflected
      // in the replay snapshot.
      sub.flush();

      const snapshot = await AppRuntime.runPromise(
        Effect.flatMap(ProjectRecapService, (s) => s.getById(ctx.params.id)),
      ).catch(() => row);

      emitSnapshot(channel, snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      channel.send({ type: "error", data: { code: "SetupError", message } });
      channel.close();
    }
  })();

  return response;
}
