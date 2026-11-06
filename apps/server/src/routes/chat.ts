// ── Chat route ─────────────────────────────────────────────────────────────
//
// The right-pane chat's HTTP surface:
//
//   POST   /api/chat               - run a turn, streamed as SSE
//   GET    /api/chat/:prId/messages - the PR's chat session's timeline
//   DELETE /api/chat/:prId         - clear the conversation and the agent's commits
//
// The turn itself is `ChatTurnService`; the agent's workspace is `PrWorkspace`.

import {
  attachmentByteSize,
  attachmentsTotalTooLargeMessage,
  attachmentTooLargeMessage,
  type ChatAttachment,
  type ChatAttachmentMetadata,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENTS_COUNT,
  MAX_CHAT_ATTACHMENTS_TOTAL_BYTES,
  type StreamErrorBody,
} from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { ChatSessionService } from "../services/ChatSession";
import { ChatTurnService } from "../services/chat/ChatTurn";
import { PrContextService } from "../services/PrContext";
import { PrWorkspace } from "../services/workspace/PrWorkspace";
import { chatInteractionRoutes } from "./chat-route-interactions";
import { chatProposedChangesRoutes } from "./chat-route-proposed-changes";
import { runRoute, withAuth } from "./middleware";
import { ownedBy } from "./ownership";
import { pipeToSse, runStream } from "./sse";

// Valid base64 alphabet, optional `=` padding, length a multiple of 4. Used to
// confirm an attachment the client labelled `image` actually carries base64
// bytes (and not, say, raw text mislabelled as an image).
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// Defense-in-depth bound on a single attachment's raw `data` string, enforced
// at the schema layer. This just rejects an absurd single field early; the
// authoritative, per-kind decoded-byte caps live in `validateAttachments`.
// Sized for the worst case — base64 image data, which inflates the byte cap by
// ~4/3, plus slack. For `text` attachments (`data` is raw UTF-8, ~1 byte/char)
// this cap therefore over-permits by ~33%; that is intentional — text relies
// entirely on the decoded-byte check in `validateAttachments`, this bound only
// exists to stop a pathologically huge single field. (Bun's global body limit
// remains the real parse-time memory guard.)
const MAX_ATTACHMENT_DATA_CHARS = Math.ceil((MAX_CHAT_ATTACHMENT_BYTES * 4) / 3) + 1024;

/**
 * Sanity-check the client-asserted `kind` at the trust boundary so downstream
 * consumers (size accounting in `attachmentByteSize`, the ACP render branch in
 * `buildPromptBlocks`) can rely on `kind` matching the payload shape — an
 * `image` carries non-empty base64 with an image MIME type; `text` does not
 * claim an image type. This is a cheap structural guard, not a semantic one:
 * valid base64 is not necessarily a decodable image (that's the agent's
 * problem). Returns a structured error string on mismatch.
 */
function validateAttachmentKind(attachment: ChatAttachment): string | null {
  if (attachment.kind === "image") {
    if (!attachment.mimeType.startsWith("image/")) {
      return `${attachment.name} is labelled an image but has a non-image type.`;
    }
    if (
      attachment.data.length === 0 ||
      attachment.data.length % 4 !== 0 ||
      !BASE64_RE.test(attachment.data)
    ) {
      return `${attachment.name} is not valid base64 image data.`;
    }
    return null;
  }
  // Text attachments carry raw UTF-8; reject anything claiming an image type.
  if (attachment.mimeType.startsWith("image/")) {
    return `${attachment.name} has an image type but was sent as text.`;
  }
  return null;
}

type AttachmentValidation =
  | { ok: true; metadata: ChatAttachmentMetadata[] }
  | {
      ok: false;
      status: 413 | 415;
      code: "ATTACHMENT_TOO_LARGE" | "ATTACHMENT_INVALID";
      message: string;
    };

function validateAttachments(
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): AttachmentValidation {
  if (!attachments || attachments.length === 0) return { ok: true, metadata: [] };
  let total = 0;
  const metadata: ChatAttachmentMetadata[] = [];
  for (const attachment of attachments) {
    const kindError = validateAttachmentKind(attachment);
    if (kindError) {
      return { ok: false, status: 415, code: "ATTACHMENT_INVALID", message: kindError };
    }
    const size = attachmentByteSize(attachment);
    if (size > MAX_CHAT_ATTACHMENT_BYTES) {
      return {
        ok: false,
        status: 413,
        code: "ATTACHMENT_TOO_LARGE",
        message: attachmentTooLargeMessage(attachment.name),
      };
    }
    total += size;
    if (total > MAX_CHAT_ATTACHMENTS_TOTAL_BYTES) {
      return {
        ok: false,
        status: 413,
        code: "ATTACHMENT_TOO_LARGE",
        message: attachmentsTotalTooLargeMessage(),
      };
    }
    metadata.push({
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size,
    });
  }
  return { ok: true, metadata };
}

export const chatRoute = new Elysia()
  .use(withAuth)
  .use(chatProposedChangesRoutes)
  .use(chatInteractionRoutes)
  .onBeforeHandle(ownedBy({ prId: "pull request" }))
  .post(
    "/api/chat",
    (ctx) => {
      const attachments = ctx.body.attachments ?? [];
      const validation = validateAttachments(attachments);
      if (!validation.ok) {
        ctx.set.status = validation.status;
        return { code: validation.code, message: validation.message };
      }
      const turn = Effect.flatMap(ChatTurnService, (turns) =>
        turns.start({
          prId: ctx.body.prId,
          userId: ctx.session.user.id,
          message: ctx.body.message,
          attachments,
          attachmentMetadata: validation.metadata,
          ...(ctx.body.interactionMode ? { interactionMode: ctx.body.interactionMode } : {}),
          ...(ctx.body.approvedPlanId ? { approvedPlanId: ctx.body.approvedPlanId } : {}),
        }),
      );
      return runStream(
        turn.pipe(
          Effect.map(pipeToSse),
          Effect.catchTag("PlanGateError", (refused) =>
            Effect.succeed(
              refused.reason === "pending"
                ? Response.json(
                    {
                      code: "PLAN_PENDING",
                      planId: refused.planId,
                      message:
                        "A plan is awaiting your decision. Approve or reject it before sending a new message.",
                    } satisfies StreamErrorBody,
                    { status: 409 },
                  )
                : Response.json(
                    {
                      code: "PLAN_NOT_FOUND",
                      planId: refused.planId,
                      message: "Plan not found",
                    } satisfies StreamErrorBody,
                    { status: 404 },
                  ),
            ),
          ),
        ),
      );
    },
    {
      body: t.Object({
        prId: t.String(),
        message: t.String(),
        attachments: t.Optional(
          t.Array(
            t.Object({
              kind: t.Union([t.Literal("image"), t.Literal("text")]),
              name: t.String({ maxLength: 1024 }),
              mimeType: t.String({ maxLength: 256 }),
              data: t.String({ maxLength: MAX_ATTACHMENT_DATA_CHARS }),
            }),
            { maxItems: MAX_CHAT_ATTACHMENTS_COUNT },
          ),
        ),
        interactionMode: t.Optional(t.Union([t.Literal("default"), t.Literal("plan")])),
        approvedPlanId: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/api/chat/:prId/messages",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const prCtx = yield* PrContextService;
          const workspace = yield* PrWorkspace;
          const chatSessions = yield* ChatSessionService;
          const { pr } = yield* prCtx.forPr(ctx.params.prId);
          const row = yield* workspace.session(pr);
          if (!row) {
            return { chatSessionId: null, entries: [], interactionMode: "default" as const };
          }
          return {
            chatSessionId: row.id,
            entries: yield* chatSessions.listTimeline(row.id),
            interactionMode: row.interactionMode,
          };
        }),
      ),
    {
      params: t.Object({ prId: t.String() }),
    },
  )
  .delete(
    "/api/chat/:prId",
    (ctx) =>
      runRoute(
        Effect.flatMap(PrWorkspace, (workspace) =>
          workspace.clear(ctx.params.prId),
        ).pipe(Effect.as(new Response(null, { status: 204 }))),
      ),
    {
      params: t.Object({ prId: t.String() }),
    },
  );
