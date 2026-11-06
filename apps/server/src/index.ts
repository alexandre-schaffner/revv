import { cors } from "@elysiajs/cors";
import { SPAN, SPAN_ATTR } from "@revv/shared/telemetry";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { auth } from "./auth";
import { serverEnv } from "./config";
import { resolveDbPath } from "./db/index";
import { watchDesktopParent } from "./desktop-parent";
import { CORS_ORIGINS } from "./http-origins";
import { logError } from "./logger";
import { isLoopbackAddress } from "./net";
import { configuredGitHubHosts, githubLedgerPath } from "./observability/github-ledger/config";
import { enterOrigin, relabelOrigin } from "./observability/github-ledger/origin";
import { installGitHubLedger } from "./observability/github-ledger/record";
import { recordSpan } from "./observability/tracer";
import { agentCheckRoutes } from "./routes/agent-check";
import { chatRoute } from "./routes/chat";
import { debugRoutes } from "./routes/debug";
import { deviceAuthRoutes } from "./routes/device-auth";
import { eventsRoute } from "./routes/events";
import { githubRoutes } from "./routes/github";
import { healthRoute } from "./routes/health";
import { externalIntegrationRoutes } from "./routes/integrations";
import { mcpChatContextRoute } from "./routes/mcp/chat-context";
import { mcpExternalAgentRoute } from "./routes/mcp/external-agent";
import { mcpRecapRoute } from "./routes/mcp/recap";
import { mcpStackBriefRoute } from "./routes/mcp/stack-brief";
import { mcpWalkthroughRoute } from "./routes/mcp/walkthrough";
import { onboardingRoutes } from "./routes/onboarding";
import { prRoutes } from "./routes/prs";
import { prBaseConflictsRoutes } from "./routes/prs-base-conflicts";
import { prConversationRoutes } from "./routes/prs-conversation";
import { recapRoutes } from "./routes/recaps";
import { repoRoutes } from "./routes/repos";
import { reviewRoutes } from "./routes/reviews";
import { settingsRoutes } from "./routes/settings";
import { stackReviewRoutes } from "./routes/stack-review";
import { repoStackRoutes, stackMergeRunRoutes, stackRoutes } from "./routes/stacks";
import { threadRoutes } from "./routes/threads";
import { updateManifestRoute } from "./routes/update-manifest";
import { userRoutes } from "./routes/user";
import { walkthroughRoutes } from "./routes/walkthrough";
import { AppRuntime } from "./runtime";
import { appDatabase } from "./services/Db";
import { acquireSingleInstance } from "./singleInstance";

// ── Single-instance guard ────────────────────────────────────────────────────
// Acquire a PID file keyed on the DB path so dev (revv-dev.db) and prod
// (revv.db) environments stay independent.  If a stale instance is found it
// is SIGTERM'd (then SIGKILL'd after 3 s) before we bind the port.
const port = serverEnv.port;
const releasePidFile = acquireSingleInstance(`${resolveDbPath()}.${serverEnv.channel}.pid`);

logError("server", `starting on port ${port}`);

const ledgerPath = githubLedgerPath();
if (ledgerPath !== null) {
  installGitHubLedger({
    path: ledgerPath,
    enterpriseHosts: () => configuredGitHubHosts(appDatabase()),
  });
}

function requestAttrs(request: Request, status: unknown): Record<string, unknown> {
  return {
    [SPAN_ATTR.httpMethod]: request.method,
    [SPAN_ATTR.urlPath]: new URL(request.url).pathname,
    [SPAN_ATTR.httpStatus]: Number(status),
  };
}

const roughRoute = (pathname: string) => pathname.replace(/\/[^/]*(?:\d|:)[^/]*/g, "/:id");

const app = new Elysia()
  .use(
    cors({
      origin: [...CORS_ORIGINS],
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  )
  .onRequest(({ request, server, set }) => {
    // Defense-in-depth: reject non-loopback peers so a future bind-widening
    // can't silently re-expose the API. Skipped when bound to a non-loopback
    // host; fails open when the peer IP is undeterminable.
    if (isLoopbackAddress(serverEnv.host)) {
      const peer = server?.requestIP(request)?.address;
      if (peer && !isLoopbackAddress(peer)) {
        set.status = 403;
        return "Forbidden: this server only accepts loopback connections";
      }
    }
  })
  .onRequest((ctx) => {
    // Stamp request start time for the post-hoc http.request span.
    (ctx.store as { _revvStartMs?: number })._revvStartMs = performance.now();
    const { pathname } = new URL(ctx.request.url);
    enterOrigin(`${ctx.request.method} ${roughRoute(pathname)}`, "request");
  })
  .onTransform({ as: "global" }, ({ request, route }) => {
    if (route) relabelOrigin(`${request.method} ${route}`);
  })
  .onAfterHandle(({ request, store, set }) => {
    const startMs = (store as { _revvStartMs?: number })._revvStartMs;
    if (startMs == null) return;
    recordSpan(
      SPAN.httpRequest,
      startMs,
      performance.now() - startMs,
      requestAttrs(request, set.status),
    );
  })
  .onError(({ request, store, set, error: err }) => {
    const startMs = (store as { _revvStartMs?: number })._revvStartMs;
    if (startMs == null) return;
    recordSpan(
      SPAN.httpRequest,
      startMs,
      performance.now() - startMs,
      requestAttrs(request, set.status ?? 500),
      err instanceof Error
        ? { name: err.name, message: err.message }
        : { name: "Error", message: String(err) },
    );
  })
  .mount(auth.handler)
  .use(chatRoute)
  .use(repoRoutes)
  .use(githubRoutes)
  .use(prRoutes)
  .use(prConversationRoutes)
  .use(prBaseConflictsRoutes)
  .use(stackRoutes)
  .use(repoStackRoutes)
  .use(stackReviewRoutes)
  .use(stackMergeRunRoutes)
  .use(recapRoutes)
  .use(reviewRoutes)
  .use(threadRoutes)
  .use(updateManifestRoute)
  .use(settingsRoutes)
  .use(deviceAuthRoutes)
  .use(onboardingRoutes)
  .use(userRoutes)
  .use(walkthroughRoutes)
  .use(eventsRoute)
  .use(debugRoutes)
  .use(mcpWalkthroughRoute)
  .use(mcpRecapRoute)
  .use(mcpStackBriefRoute)
  .use(mcpChatContextRoute)
  .use(mcpExternalAgentRoute)
  .use(externalIntegrationRoutes)
  .use(agentCheckRoutes)
  .use(healthRoute)
  .listen({
    port,
    // Loopback only — without a hostname Bun binds to 0.0.0.0 (every interface).
    hostname: serverEnv.host,
    // Prevent Bun's default idle timeout from killing long-running SSE streams
    // (e.g. agent chat turns that go quiet for >10 s during tool execution).
    idleTimeout: 255,
  });

logError("server", `listening on http://${serverEnv.host}:${port}`);

enterOrigin("boot", "boot");

// ── Graceful shutdown ────────────────────────────────────────────────────────
// SIGTERM arrives on bun --watch restarts and desktop shutdown.
// SIGINT  arrives on Ctrl-C.
//
// Registered before the first `await`: the server already answers requests,
// and building the runtime installs other SIGTERM listeners (git-runner) that
// suppress Bun's default exit, so a signal landing earlier would be swallowed.
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

  // Stop accepting connections, then dispose the runtime: it interrupts the
  // schedulers and job fibers (their rows stay `generating` for resume) and
  // stops the agent connection pool.
  try {
    app.stop();
  } catch (err) {
    logError("server", "stopping the HTTP server failed:", err);
  }
  await AppRuntime.dispose().catch((err) => {
    logError("server", "disposing the runtime failed:", err);
  });

  // Release the PID file so the next startup doesn't treat us as stale.
  releasePidFile();

  process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
watchDesktopParent(serverEnv.desktopPid, () => void gracefulShutdown("desktop exited"));

// The runtime builds lazily: force it now, which runs the boot sequence
// (`boot.ts`) — resume-on-boot, the schedulers and the sweeps.
await AppRuntime.runPromise(Effect.void).catch((err) => {
  logError("server", "runtime failed to start:", err);
});

export type App = typeof app;
