import { type InstallEvent, isAcpAgentId } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { db } from "../auth";
import { user } from "../db/schema";
import { AppRuntime } from "../runtime";
import { OnboardingService } from "../services/Onboarding";
import { handleAppError, withAuth } from "./middleware";
import { createSseStream, sseHeaders } from "./reviews/sse";

/**
 * Onboarding routes.
 *
 * - `/complete` and `/reset` are the gate flips for the `onboardedAt`
 *   column the SvelteKit `OnboardingGate` reads.
 * - `/agent-availability` / `/install` are the agent-step plumbing: detect
 *   which CLI agents are installed and run the selected agent's official
 *   installer with a streamed log so the user can see progress without
 *   leaving the onboarding wizard.
 */
export const onboardingRoutes = new Elysia({ prefix: "/api/onboarding" })
  .use(withAuth)
  .post("/complete", async (ctx) => {
    try {
      const userId = ctx.session.user.id;
      const now = new Date();

      const existing = await db
        .select({ onboardedAt: user.onboardedAt })
        .from(user)
        .where(eq(user.id, userId));
      const current = existing[0]?.onboardedAt ?? null;

      if (current) {
        return { onboardedAt: current.toISOString() };
      }

      await db.update(user).set({ onboardedAt: now, updatedAt: now }).where(eq(user.id, userId));

      return { onboardedAt: now.toISOString() };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  /**
   * Clear the user's `onboardedAt` so the gate re-shows the flow on next
   * render. Used by the "Replay onboarding" affordance in settings —
   * auth and tracked repos are intentionally untouched. The frontend
   * pairs this with a sessionStorage flag that forces the flow to start
   * from the welcome step rather than honoring its usual resume logic.
   */
  .post("/reset", async (ctx) => {
    try {
      const userId = ctx.session.user.id;
      await db
        .update(user)
        .set({ onboardedAt: null, updatedAt: new Date() })
        .where(eq(user.id, userId));
      return { onboardedAt: null };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  /**
   * Snapshot of which CLI agents are present on PATH (or pinned via the
   * LaunchAgent env vars). Used by the agent-selection onboarding step to
   * tag each picker option installed/not-installed and key the adaptive
   * Install/Continue CTA.
   */
  .get("/agent-availability", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(OnboardingService, (s) => s.detectAgents()),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  /**
   * Kick off (or join) the install job for the selected registry agent.
   * Idempotent per agent — concurrent requests for the same agent get the
   * same `jobId`. Body: `{ agent: AcpAgentId }`.
   */
  .post("/install", async (ctx) => {
    try {
      const agent = (ctx.body as { agent?: unknown } | undefined)?.agent;
      if (typeof agent !== "string" || !isAcpAgentId(agent)) {
        ctx.set.status = 400;
        return { error: "Invalid or missing agent" };
      }
      return await AppRuntime.runPromise(
        Effect.flatMap(OnboardingService, (s) => s.startInstall(agent)),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  /**
   * SSE stream of `InstallEvent`s. Replays the log captured up to the
   * subscription point and then forwards live events until `done`. Closes
   * the stream after `done` (success or failure).
   */
  .get("/install/stream", async (ctx) => {
    const jobId = ctx.query?.jobId;
    if (typeof jobId !== "string" || jobId.length === 0) {
      ctx.set.status = 400;
      return { error: "Missing jobId" };
    }

    const { stream, writer, stopHeartbeat, onCancel } = createSseStream();
    onCancel(() => stopHeartbeat());

    const send = (event: InstallEvent): void => {
      writer.send(event);
      if (event.type === "done") writer.sendDone();
    };

    try {
      const sub = await AppRuntime.runPromise(
        Effect.flatMap(OnboardingService, (s) => s.subscribe(jobId, send)),
      );

      if (!sub.found) {
        writer.send({
          type: "done",
          success: false,
          error: "Unknown install job",
        } satisfies InstallEvent);
        writer.sendDone();
        return new Response(stream, { headers: sseHeaders });
      }

      onCancel(sub.unsubscribe);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Subscription failed";
      writer.send({ type: "done", success: false, error: message } satisfies InstallEvent);
      writer.sendDone();
    }

    return new Response(stream, { headers: sseHeaders });
  });
