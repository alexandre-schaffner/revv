import { ACP_AGENT_IDS, type InstallEvent, type LoginEvent } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { invalidateAgentProbes } from "../ai/acp/agents";
import { user } from "../db/schema";
import { ValidationError } from "../domain/errors";
import { tryDb } from "../effects/db-try";
import type { AppServices } from "../runtime";
import { AgentLoginService } from "../services/AgentLogin";
import { OnboardingService } from "../services/Onboarding";
import { runRoute, withAuth } from "./middleware";
import { literalUnion } from "./schemas";
import { openSse, runStream } from "./sse";

const agentBody = t.Object({ agent: literalUnion(ACP_AGENT_IDS) });
const jobIdField = t.String({ minLength: 1 });

/**
 * Stream a job's events: the owning service replays what the job logged so
 * far, then forwards live events until the terminal `done`. Shared by the
 * install and login streams.
 */
function streamJobEvents<E extends { type: string }>(
  jobId: string | undefined,
  subscribe: (
    jobId: string,
    send: (event: E) => void,
  ) => Effect.Effect<{ found: boolean; unsubscribe: () => void }, never, AppServices>,
  notFoundEvent: E,
): Promise<Response> {
  return runStream(
    Effect.gen(function* () {
      if (!jobId) return yield* new ValidationError({ message: "Missing jobId" });
      const { response, channel } = openSse<E>();
      const send = (event: E): void => {
        channel.send(event);
        if (event.type === "done") channel.done();
      };
      const sub = yield* subscribe(jobId, send);
      if (sub.found) channel.onClose(sub.unsubscribe);
      else send(notFoundEvent);
      return response;
    }),
  );
}

/**
 * - `/complete` and `/reset` flip the `onboardedAt` column the SvelteKit
 *   `OnboardingGate` reads.
 * - `/agent-status` / `/install` / `/login` are the agent step: detect which
 *   CLI agents are set up, run the selected agent's official installer, and
 *   drive its interactive login — each streaming progress over SSE so the
 *   user never leaves the onboarding wizard.
 */
export const onboardingRoutes = new Elysia({ prefix: "/api/onboarding" })
  .use(withAuth)
  .post("/complete", (ctx) =>
    runRoute(
      tryDb("complete onboarding", (db) => {
        const userId = ctx.session.user.id;
        const current = db
          .select({ onboardedAt: user.onboardedAt })
          .from(user)
          .where(eq(user.id, userId))
          .get()?.onboardedAt;
        if (current) return { onboardedAt: current.toISOString() };

        const now = new Date();
        db.update(user).set({ onboardedAt: now, updatedAt: now }).where(eq(user.id, userId)).run();
        return { onboardedAt: now.toISOString() };
      }),
    ),
  )
  /**
   * Clear the user's `onboardedAt` so the gate re-shows the flow on next
   * render. Used by the "Replay onboarding" affordance in settings —
   * auth and tracked repos are intentionally untouched. The frontend
   * pairs this with a sessionStorage flag that forces the flow to start
   * from the welcome step rather than honoring its usual resume logic.
   */
  .post("/reset", (ctx) =>
    runRoute(
      tryDb("reset onboarding", (db) =>
        db
          .update(user)
          .set({ onboardedAt: null, updatedAt: new Date() })
          .where(eq(user.id, ctx.session.user.id))
          .run(),
      ).pipe(Effect.as({ onboardedAt: null })),
    ),
  )
  /**
   * Single detection snapshot the agent-selection step consumes: per-agent
   * installed + authed + login command, plus whether this host supports the
   * embedded PTY login. Drives the picker's installed/needs-sign-in tags and the
   * adaptive Install / Sign-in / Continue CTA.
   */
  .get("/agent-status", async (ctx) => {
    if (ctx.query?.refresh === "1") invalidateAgentProbes();
    return runRoute(Effect.flatMap(OnboardingService, (s) => s.detectAgentStatus()));
  })
  /**
   * Kick off (or join) the install job for the selected registry agent.
   * Idempotent per agent — concurrent requests for the same agent get the
   * same `jobId`. Body: `{ agent: AcpAgentId }`.
   */
  .post(
    "/install",
    (ctx) => runRoute(Effect.flatMap(OnboardingService, (s) => s.startInstall(ctx.body.agent))),
    { body: agentBody },
  )
  .get("/install/stream", (ctx) =>
    streamJobEvents<InstallEvent>(
      ctx.query?.jobId,
      (jobId, send) => Effect.flatMap(OnboardingService, (s) => s.subscribe(jobId, send)),
      { type: "done", success: false, error: "Unknown install job" },
    ),
  )
  /**
   * Kick off (or join) the interactive login job for the selected agent — its
   * official login command runs in a PTY whose output streams back over SSE.
   * Idempotent per agent. Body: `{ agent: AcpAgentId }`.
   */
  .post(
    "/login",
    (ctx) => runRoute(Effect.flatMap(AgentLoginService, (s) => s.startLogin(ctx.body.agent))),
    { body: agentBody },
  )
  /**
   * Forward a chunk of user keystrokes to the login job's PTY (e.g. a pasted
   * auth code). Body: `{ jobId, data }`.
   */
  .post(
    "/login/input",
    (ctx) =>
      runRoute(
        Effect.flatMap(AgentLoginService, (s) => s.writeInput(ctx.body.jobId, ctx.body.data)),
      ),
    { body: t.Object({ jobId: jobIdField, data: t.String() }) },
  )
  /**
   * Tear down a login job's PTY when the user abandons sign-in (skip / unmount /
   * navigate-away), so the spawned interactive CLI never orphans on the server.
   * Idempotent. Body: `{ jobId }`.
   */
  .post(
    "/login/cancel",
    (ctx) => runRoute(Effect.flatMap(AgentLoginService, (s) => s.cancelLogin(ctx.body.jobId))),
    { body: t.Object({ jobId: jobIdField }) },
  )
  .get("/login/stream", (ctx) =>
    streamJobEvents<LoginEvent>(
      ctx.query?.jobId,
      (jobId, send) => Effect.flatMap(AgentLoginService, (s) => s.subscribe(jobId, send)),
      { type: "done", success: false, error: "Unknown login job" },
    ),
  );
