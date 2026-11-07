import { AUTHOR_ROLES, MESSAGE_TYPES } from "@revv/shared";
import { t } from "elysia";
import { literalUnion } from "./schemas";

/** A message posted on a review thread, as the web sends it. */
export const threadMessageBody = t.Object({
  authorRole: literalUnion(AUTHOR_ROLES),
  authorName: t.String(),
  authorLogin: t.Optional(t.String()),
  body: t.String(),
  messageType: literalUnion(MESSAGE_TYPES),
  codeSuggestion: t.Optional(t.String()),
});
