// A reconnect replays the current `lede`, each entry and theme summary from
// the DB, then attaches to live events while the job is still running.

import type { ProjectRecap, RecapStreamEvent } from "@revv/shared";
import { Effect } from "effect";
import { httpErrorOf } from "../../domain/errors";
import { ProjectRecapService } from "../../services/recaps/ProjectRecap";
import { ProjectRecapJobs, recapTerminalEvent } from "../../services/recaps/ProjectRecapJobs";
import { openSse, runStream, type SseChannel } from "../sse";

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

const endsStream = (event: RecapStreamEvent): boolean =>
  event.type === "done" ||
  event.type === "stopped" ||
  event.type === "error" ||
  event.type === "restarted";

/** A finished row: a complete one replays its content first. */
function replayFinished(
  channel: SseChannel<RecapStreamEvent>,
  row: ProjectRecap,
  end: RecapStreamEvent,
): void {
  if (end.type === "done") {
    emitSnapshot(channel, row);
    channel.send(end);
    channel.done();
    return;
  }
  channel.send(end);
  channel.close();
}

export function recapStreamHandler(ctx: { params: { id: string } }): Promise<Response> {
  const recapId = ctx.params.id;
  return runStream(
    Effect.gen(function* () {
      const recaps = yield* ProjectRecapService;
      const jobs = yield* ProjectRecapJobs;
      const row = yield* recaps.getById(recapId);
      const { response, channel } = openSse<RecapStreamEvent>();

      const finished = recapTerminalEvent(row);
      if (finished) {
        replayFinished(channel, row, finished);
        return response;
      }

      yield* Effect.gen(function* () {
        // The budgeted resume when the run writing this row died.
        yield* jobs.attach(recapId);

        // Subscribed in buffered mode before the snapshot read, so nothing
        // committed in between is missed.
        const sub = yield* jobs.subscribe(recapId, (event) => {
          channel.send(event);
          if (endsStream(event)) channel.close();
        });

        if (!sub.found) {
          // No live run: it finished, or its resume was refused.
          const now = yield* recaps.getById(recapId);
          const end = recapTerminalEvent(now);
          if (end) replayFinished(channel, now, end);
          else channel.close();
          return;
        }

        channel.onClose(sub.unsubscribe);
        // Buffered events go out in arrival order before the snapshot, which
        // is re-read so writes committed since the first read are in it.
        sub.flush();
        emitSnapshot(channel, yield* recaps.getById(recapId));
      }).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            const { code, message, details } = httpErrorOf(err);
            channel.fail({ ...details, code, message });
          }),
        ),
      );
      return response;
    }),
  );
}
