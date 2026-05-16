import { cors } from "@elysiajs/cors";
import { API_PORT } from "@revv/shared";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { auth } from "./auth";
import { serverEnv } from "./config";
import { logError } from "./logger";
import { chatRoute } from "./routes/chat";
import { debugRoutes } from "./routes/debug";
import { deviceAuthRoutes } from "./routes/device-auth";
import { githubRoutes } from "./routes/github";
import { mcpChatContextRoute } from "./routes/mcp/chat-context";
import { mcpWalkthroughRoute } from "./routes/mcp/walkthrough";
import { onboardingRoutes } from "./routes/onboarding";
import { prRoutes } from "./routes/prs";
import { repoRoutes } from "./routes/repos";
import { reviewRoutes } from "./routes/reviews";
import { settingsRoutes } from "./routes/settings";
import { signOutRoute } from "./routes/sign-out";
import { threadRoutes } from "./routes/threads";
import { userRoutes } from "./routes/user";
import { wsRoute } from "./routes/ws";
import { AppRuntime } from "./runtime";
import { ChatSessionService } from "./services/ChatSession";
import { DbMaintenance } from "./services/DbMaintenance";
import { PollScheduler } from "./services/PollScheduler";
import { ensureHighlighter } from "./services/PrerenderCache";
import { RepoCloneService } from "./services/RepoClone";
import { WalkthroughJobs } from "./services/WalkthroughJobs";
import { acquireSingleInstance } from "./singleInstance";

// ── Single-instance guard ────────────────────────────────────────────────────
// Acquire a PID file keyed on the DB path so dev (revv-dev.db) and prod
// (revv.db) environments stay independent.  If a stale instance is found it
// is SIGTERM'd (then SIGKILL'd after 3 s) before we bind the port.
const port = Number(process.env.PORT) || API_PORT;
const releasePidFile = acquireSingleInstance(`${serverEnv.dbPath}.pid`);

logError("server", `starting on port ${port}`);

const app = new Elysia()
  .use(
    cors({
      origin: /localhost/,
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  )
  .mount(auth.handler)
  .use(chatRoute)
  .use(repoRoutes)
  .use(githubRoutes)
  .use(prRoutes)
  .use(reviewRoutes)
  .use(threadRoutes)
  .use(settingsRoutes)
  .use(signOutRoute)
  .use(deviceAuthRoutes)
  .use(onboardingRoutes)
  .use(userRoutes)
  .use(wsRoute)
  .use(debugRoutes)
  .use(mcpWalkthroughRoute)
  .use(mcpChatContextRoute)
  .get("/api/health", () => ({
    status: "ok" as const,
    timestamp: new Date().toISOString(),
  }))
  .listen({
    port,
    // Prevent Bun's default idle timeout from killing long-running SSE streams
    // (e.g. agent chat turns that go quiet for >10 s during tool execution).
    idleTimeout: 255,
  });

logError("server", `listening on http://localhost:${port}`);

// ── Graceful shutdown ────────────────────────────────────────────────────────
// SIGTERM arrives on bun --watch restarts and launchd stops.
// SIGINT  arrives on Ctrl-C.
//
// Both previously only logged, leaving the process alive — that's why stale
// instances accumulated.  Now we: stop Elysia, dispose the Effect runtime
// (drains PollScheduler / WalkthroughJobs fibers), remove the PID file,
// then exit.  A hard-kill timer fires after 8 s so a stuck Effect fiber
// can never hold the process open forever.
let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    // Second signal while already shutting down → force exit immediately.
    process.exit(1);
  }
  isShuttingDown = true;

  logError("server", `${signal} received — shutting down…`);

  // Hard-kill fallback: if shutdown takes more than 8 s, give up.
  const hardKill = setTimeout(() => {
    logError("server", "shutdown timed out after 8 s — force exit");
    process.exit(1);
  }, 8000);
  // Don't let this timer keep the process alive past a normal exit.
  hardKill.unref();

  // 1. Stop accepting new connections (drains in-flight requests).
  try {
    app.stop();
  } catch {}

  // 2. Dispose the Effect runtime — stops PollScheduler, WalkthroughJobs, etc.
  try {
    await AppRuntime.dispose();
  } catch {}

  // 3. Release the PID file so the next startup doesn't treat us as stale.
  releasePidFile();

  process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

// Re-launch walkthrough fibers for any rows left in `status='generating'`
// by a previous run. Runs in the background so boot isn't blocked by slow
// git clones or GitHub API calls; any per-row failures are logged and
// retries are capped via `resumeAttempts` so a poisoned row can't loop
// forever. Best-effort: we never want this to crash the server.
AppRuntime.runPromise(Effect.flatMap(WalkthroughJobs, (jobs) => jobs.resumePending())).catch(
  (err) => {
    logError("walkthrough-resume", "resumePending failed on boot:", err);
  },
);

// Start the background sync scheduler on boot, decoupled from any UI
// client. Previously this was triggered from the WebSocket `open` handler,
// which meant sync only ran while the desktop window was open. With the
// Tauri app running in tray mode (window hidden / closed to tray), the
// server is the only long-lived process — it must drive its own polling.
//
// `start()` is idempotent (guards against duplicate fibers internally) and
// the sync loop gracefully no-ops when no GitHub token is available yet,
// so it's safe to call before the user has signed in.
AppRuntime.runPromise(Effect.flatMap(PollScheduler, (s) => s.start())).catch((err) => {
  logError("poll-scheduler", "start failed on boot:", err);
});

// Resume any repos with cloneStatus 'pending' or 'error' on boot so that
// repos that failed to clone (e.g. due to a server restart mid-clone) are
// automatically retried without requiring user intervention.
AppRuntime.runPromise(Effect.flatMap(RepoCloneService, (svc) => svc.resumePendingClones())).catch(
  (err) => {
    logError("repo-clone", "resumePendingClones failed on boot:", err);
  },
);

// Start DB maintenance scheduler: sweeps expired cache rows and checkpoints
// the WAL every 6 hours to prevent unbounded disk growth.
AppRuntime.runPromise(Effect.flatMap(DbMaintenance, (svc) => svc.start())).catch((err) => {
  logError("db-maintenance", "start failed on boot:", err);
});

// Warm the shared Shiki highlighter used by every @pierre/diffs/ssr call.
// Idempotent and defensively re-awaited inside each prerender call, so a
// slow boot doesn't block the listen() above; we just want the first real
// walkthrough emit to hit a warm cache instead of paying Shiki's startup.
ensureHighlighter()
  .then(() => logError("prerender", "highlighter preloaded"))
  .catch((err) => logError("prerender", "ensureHighlighter failed on boot:", err));

// Terminal-on-crash for pending chat questions. The Claude SDK's in-memory
// deferred is gone after a process restart and the opencode daemon may also
// have lost question state; either way, the agent run that asked is dead.
// Mark these rows `superseded` so the UI renders them muted and the user
// knows to re-ask via a new message.
AppRuntime.runPromise(
  Effect.flatMap(ChatSessionService, (svc) => svc.supersedePendingQuestionsOnBoot()),
)
  .then((n) => {
    if (n > 0) {
      logError("chat-questions", `marked ${n} pending question(s) as superseded on boot`);
    }
  })
  .catch((err) => {
    logError("chat-questions", "supersedePendingQuestionsOnBoot failed:", err);
  });

export type App = typeof app;
