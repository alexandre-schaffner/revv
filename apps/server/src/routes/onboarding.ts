import { type InstallEvent, isAcpAgentId, type LoginEvent } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { invalidateCliAgentCache } from "../ai/providers/cli-agent";
import { db } from "../auth";
import { user } from "../db/schema";
import { AppRuntime } from "../runtime";
import { AgentLoginService } from "../services/AgentLogin";
import { OnboardingService } from "../services/Onboarding";
import { handleAppError, withAuth } from "./middleware";
import { createSseStream, sseHeaders } from "./reviews/sse";

/**
 * Stream a job's events over SSE. Validates `jobId`, opens an SSE stream,
 * resolves the subscription (via the owning service), replays the captured
 * buffer, and forwards live events until the terminal `{ type: 'done' }` — then
 * closes the stream. Shared by the install and login streams, which differ only
 * in their service and their "unknown job" error text.
 */
async function streamJobEvents<E extends { type: string }>(
  ctx: { query: Record<string, string | undefined>; set: { status?: number | string } },
  resolve: (
    jobId: string,
    send: (event: E) => void,
  ) => Promise<{ found: boolean; unsubscribe: () => void }>,
  notFoundEvent: E,
): Promise<Response | { error: string }> {
  const jobId = ctx.query?.jobId;
  if (typeof jobId !== "string" || jobId.length === 0) {
    ctx.set.status = 400;
    return { error: "Missing jobId" };
  }

  const { stream, writer, stopHeartbeat, onCancel } = createSseStream();
  onCancel(() => stopHeartbeat());

  const send = (event: E): void => {
    writer.send(event);
    if (event.type === "done") writer.sendDone();
  };

  try {
    const sub = await resolve(jobId, send);
    if (!sub.found) {
      send(notFoundEvent);
      return new Response(stream, { headers: sseHeaders });
    }
    onCancel(sub.unsubscribe);
  } catch (err) {
    // The shared terminal `done` shape across both event unions — `writer.send`
    // takes `unknown`, so no generic cast is needed to close the stream.
    const message = err instanceof Error ? err.message : "Subscription failed";
    writer.send({ type: "done", success: false, error: message });
    writer.sendDone();
  }

  return new Response(stream, { headers: sseHeaders });
}

/**
 * Onboarding routes.
 *
 * - `/complete` and `/reset` are the gate flips for the `onboardedAt`
 *   column the SvelteKit `OnboardingGate` reads.
 * - `/agent-status` / `/install` / `/login` are the agent-step plumbing: detect
 *   which CLI agents are set up, run the selected agent's official installer,
 *   and drive its interactive login — each streaming progress over SSE so the
 *   user never leaves the onboarding wizard.
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
   * Single detection snapshot the agent-selection step consumes: per-agent
   * installed + authed + login command, plus whether this host supports the
   * embedded PTY login. Drives the picker's installed/needs-sign-in tags and the
   * adaptive Install / Sign-in / Continue CTA.
   */
  .get("/agent-status", async (ctx) => {
    try {
      if (ctx.query?.refresh === "1") invalidateCliAgentCache();
      return await AppRuntime.runPromise(
        Effect.flatMap(OnboardingService, (s) => s.detectAgentStatus()),
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
  .get("/install/stream", (ctx) =>
    streamJobEvents<InstallEvent>(
      ctx,
      (jobId, send) =>
        AppRuntime.runPromise(Effect.flatMap(OnboardingService, (s) => s.subscribe(jobId, send))),
      { type: "done", success: false, error: "Unknown install job" },
    ),
  )
  /**
   * Kick off (or join) the interactive login job for the selected agent — its
   * official login command runs in a PTY whose output streams back over SSE.
   * Idempotent per agent. Body: `{ agent: AcpAgentId }`.
   */
  .post("/login", async (ctx) => {
    try {
      const agent = (ctx.body as { agent?: unknown } | undefined)?.agent;
      if (typeof agent !== "string" || !isAcpAgentId(agent)) {
        ctx.set.status = 400;
        return { error: "Invalid or missing agent" };
      }
      return await AppRuntime.runPromise(
        Effect.flatMap(AgentLoginService, (s) => s.startLogin(agent)),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  /**
   * Forward a chunk of user keystrokes to the login job's PTY (e.g. a pasted
   * auth code). Body: `{ jobId, data }`.
   */
  .post("/login/input", async (ctx) => {
    try {
      const body = ctx.body as { jobId?: unknown; data?: unknown } | undefined;
      const jobId = body?.jobId;
      const data = body?.data;
      if (typeof jobId !== "string" || jobId.length === 0 || typeof data !== "string") {
        ctx.set.status = 400;
        return { error: "Missing jobId or data" };
      }
      return await AppRuntime.runPromise(
        Effect.flatMap(AgentLoginService, (s) => s.writeInput(jobId, data)),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  /**
   * Tear down a login job's PTY when the user abandons sign-in (skip / unmount /
   * navigate-away), so the spawned interactive CLI never orphans on the server.
   * Idempotent. Body: `{ jobId }`.
   */
  .post("/login/cancel", async (ctx) => {
    try {
      const jobId = (ctx.body as { jobId?: unknown } | undefined)?.jobId;
      if (typeof jobId !== "string" || jobId.length === 0) {
        ctx.set.status = 400;
        return { error: "Missing jobId" };
      }
      return await AppRuntime.runPromise(
        Effect.flatMap(AgentLoginService, (s) => s.cancelLogin(jobId)),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  /**
   * SSE stream of `LoginEvent`s. Replays the terminal output captured up to the
   * subscription point and then forwards live events until `done`. Closes the
   * stream after `done` (success or failure).
   */
  .get("/login/stream", (ctx) =>
    streamJobEvents<LoginEvent>(
      ctx,
      (jobId, send) =>
        AppRuntime.runPromise(Effect.flatMap(AgentLoginService, (s) => s.subscribe(jobId, send))),
      { type: "done", success: false, error: "Unknown login job" },
    ),
  );
