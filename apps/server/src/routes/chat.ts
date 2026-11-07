import {
  attachmentByteSize,
  attachmentsTotalTooLargeMessage,
  attachmentTooLargeMessage,
  type ChatAttachment,
  type ChatAttachmentMetadata,
  INTERACTION_MODES,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENTS_COUNT,
  MAX_CHAT_ATTACHMENTS_TOTAL_BYTES,
} from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { AttachmentRejectedError } from "../domain/errors";
import { ChatSessionService } from "../services/chat/ChatSession";
import { ChatTurnService } from "../services/chat/ChatTurn";
import { PrContextService } from "../services/PrContext";
import { PrWorkspace } from "../services/workspace/PrWorkspace";
import { chatInteractionRoutes } from "./chat-route-interactions";
import { chatProposedChangesRoutes } from "./chat-route-proposed-changes";
import { runRoute, withAuth } from "./middleware";
import { ownedBy } from "./ownership";
import { literalUnion } from "./schemas";
import { pipeToSse, runStream } from "./sse";

// Confirms an attachment labelled `image` carries base64 bytes, not
// mislabelled raw text.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// Rejects an absurd single `data` field at the schema layer. The real caps are
// the per-kind decoded-byte checks in `validateAttachments`; this one is sized
// for base64 image data (~4/3 of the byte cap) plus slack, so it over-permits
// raw-UTF-8 `text` by ~33% on purpose. Bun's global body limit is the
// parse-time memory guard.
const MAX_ATTACHMENT_DATA_CHARS = Math.ceil((MAX_CHAT_ATTACHMENT_BYTES * 4) / 3) + 1024;

/**
 * Check the client-asserted `kind` at the trust boundary, so size accounting
 * (`attachmentByteSize`) and the ACP render branch (`buildPromptBlocks`) can
 * rely on it matching the payload. Structural only: valid base64 is not
 * necessarily a decodable image.
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
  if (attachment.mimeType.startsWith("image/")) {
    return `${attachment.name} has an image type but was sent as text.`;
  }
  return null;
}

function validateAttachments(
  attachments: ReadonlyArray<ChatAttachment>,
): Effect.Effect<ChatAttachmentMetadata[], AttachmentRejectedError> {
  let total = 0;
  const metadata: ChatAttachmentMetadata[] = [];
  for (const attachment of attachments) {
    const kindError = validateAttachmentKind(attachment);
    if (kindError) {
      return Effect.fail(new AttachmentRejectedError({ reason: "invalid", message: kindError }));
    }
    const size = attachmentByteSize(attachment);
    if (size > MAX_CHAT_ATTACHMENT_BYTES) {
      return Effect.fail(
        new AttachmentRejectedError({
          reason: "too-large",
          message: attachmentTooLargeMessage(attachment.name),
        }),
      );
    }
    total += size;
    if (total > MAX_CHAT_ATTACHMENTS_TOTAL_BYTES) {
      return Effect.fail(
        new AttachmentRejectedError({
          reason: "too-large",
          message: attachmentsTotalTooLargeMessage(),
        }),
      );
    }
    metadata.push({
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size,
    });
  }
  return Effect.succeed(metadata);
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
      return runStream(
        Effect.gen(function* () {
          const attachmentMetadata = yield* validateAttachments(attachments);
          const turns = yield* ChatTurnService;
          return yield* turns.start({
            prId: ctx.body.prId,
            message: ctx.body.message,
            attachments,
            attachmentMetadata,
            ...(ctx.body.interactionMode ? { interactionMode: ctx.body.interactionMode } : {}),
            ...(ctx.body.approvedPlanId ? { approvedPlanId: ctx.body.approvedPlanId } : {}),
          });
        }).pipe(Effect.map(pipeToSse)),
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
        interactionMode: t.Optional(literalUnion(INTERACTION_MODES)),
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
          const { pr } = yield* prCtx.readPr(ctx.params.prId);
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
        Effect.flatMap(PrWorkspace, (workspace) => workspace.clear(ctx.params.prId)).pipe(
          Effect.as(new Response(null, { status: 204 })),
        ),
      ),
    {
      params: t.Object({ prId: t.String() }),
    },
  );
