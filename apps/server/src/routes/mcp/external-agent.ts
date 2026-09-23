import {
  EXTERNAL_AGENT_PROVIDER_NAMES,
  type ThreadEventMessage,
  type WalkthroughStreamEvent,
} from "@revv/shared";
import { Effect } from "effect";
import {
  EXTERNAL_REVIEW_TOOL_BUNDLE,
  type ExternalReviewToolContext,
  hasExternalToolScope,
} from "../../ai/providers/external-review-tools";
import { externalIntegrationHttpStatus } from "../../domain/errors";
import { logError } from "../../logger";
import { AppRuntime } from "../../runtime";
import { fireAndForgetThreadEventBroadcast } from "../../services/broadcast-thread-event";
import { DbService } from "../../services/Db";
import {
  type ExternalAuthorizedContext,
  ExternalIntegrations,
  type ExternalProjectIdentity,
} from "../../services/ExternalIntegrations";
import { RemoteWalkthroughCache } from "../../services/RemoteWalkthroughCache";
import { SyncService } from "../../services/Sync";
import { WalkthroughJobs } from "../../services/WalkthroughJobs";
import { bindHttp, type ContextResolution, extractBearer } from "./utils";

const LOG_SCOPE = "mcp-external";

function projectIdentity(request: Request): ExternalProjectIdentity | null {
  const repositoryFullName = request.headers.get("X-Revv-Repository")?.trim() ?? "";
  const headCandidates = (request.headers.get("X-Revv-Head-Candidates") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const branch = request.headers.get("X-Revv-Branch")?.trim() || null;
  if (!repositoryFullName || headCandidates.length === 0) return null;
  return { repositoryFullName, headCandidates, branch };
}

async function resolveContext(
  request: Request,
): Promise<ContextResolution<ExternalReviewToolContext, ExternalAuthorizedContext>> {
  const token = extractBearer(request);
  if (!token) return { ok: false, status: 401, message: "Missing bearer token" };
  const project = projectIdentity(request);
  if (!project) {
    return { ok: false, status: 400, message: "Missing or invalid checkout identity" };
  }

  const resolution = await AppRuntime.runPromise(
    Effect.flatMap(ExternalIntegrations, (integrations) =>
      integrations.resolve(token, project),
    ).pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false as const, error }),
        onSuccess: (value) => ({ ok: true as const, value }),
      }),
    ),
  );
  if (!resolution.ok) {
    const status = externalIntegrationHttpStatus(resolution.error);
    return { ok: false, status, message: resolution.error.message };
  }
  const resolved = resolution.value;
  const db = await AppRuntime.runPromise(
    Effect.flatMap(DbService, (service) => Effect.succeed(service.db)),
  );

  const emit = (walkthroughId: string, event: WalkthroughStreamEvent): void => {
    void AppRuntime.runPromise(
      Effect.flatMap(WalkthroughJobs, (jobs) =>
        Effect.gen(function* () {
          yield* jobs.emitEvent(walkthroughId, {
            type: "lifecycle:edited",
            data: { walkthroughId, editedAt: new Date().toISOString() },
          });
          yield* jobs.emitEvent(walkthroughId, event);
        }),
      ),
    ).catch((error) => {
      logError(
        LOG_SCOPE,
        "walkthrough:event emit failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
    void AppRuntime.runPromise(
      Effect.flatMap(RemoteWalkthroughCache, (cache) =>
        cache.push(walkthroughId).pipe(Effect.catchAll(() => Effect.void)),
      ),
    ).catch((error) => {
      logError(
        LOG_SCOPE,
        "remote cache push after edit failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  };

  const broadcastThreadEvent = (message: ThreadEventMessage): void => {
    fireAndForgetThreadEventBroadcast(
      LOG_SCOPE,
      resolved.prId,
      resolved.userId,
      message,
      resolved.accountId,
    );
  };

  return {
    ok: true,
    ctx: {
      db,
      prId: resolved.prId,
      prHeadSha: resolved.prHeadSha,
      userId: resolved.userId,
      actor: resolved.provider,
      provider: resolved.provider,
      providerName: EXTERNAL_AGENT_PROVIDER_NAMES[resolved.provider],
      integrationId: resolved.integrationId,
      emit,
      broadcastThreadEvent,
      pushReply: (messageId) =>
        AppRuntime.runPromise(Effect.flatMap(SyncService, (sync) => sync.pushReply(messageId))),
      pushThreadStatus: (threadId) =>
        AppRuntime.runPromise(
          Effect.flatMap(SyncService, (sync) =>
            sync.pushThreadStatus(threadId).pipe(Effect.asVoid),
          ),
        ),
    },
    meta: resolved,
  };
}

async function resolveConnection(request: Request) {
  const token = extractBearer(request);
  if (!token) return { ok: false as const, status: 401, message: "Missing bearer token" };
  const resolution = await AppRuntime.runPromise(
    Effect.flatMap(ExternalIntegrations, (integrations) => integrations.authenticate(token)).pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false as const, error }),
        onSuccess: (value) => ({ ok: true as const, value }),
      }),
    ),
  );
  if (!resolution.ok) {
    return {
      ok: false as const,
      status: externalIntegrationHttpStatus(resolution.error),
      message: resolution.error.message,
    };
  }
  return { ok: true as const, meta: resolution.value };
}

export const mcpExternalAgentRoute = bindHttp({
  path: "/external",
  logScope: LOG_SCOPE,
  bundle: EXTERNAL_REVIEW_TOOL_BUNDLE,
  resolveContext,
  resolveConnection,
  serverVersion: "1.0.0",
  specsForList: (specs, resolved) =>
    specs.filter((spec) => hasExternalToolScope(spec.name, resolved.scopes)),
  rejectToolCall: (name, resolved) =>
    hasExternalToolScope(name, resolved.scopes)
      ? null
      : `tools/call: '${name}' is not authorized for this integration.`,
  servedMessage: (requests, ctx) =>
    `served ${requests.length} request(s), prId=${ctx.prId}, actor=${ctx.actor}`,
});
