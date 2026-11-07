import { MESSAGE_TYPES } from "@revv/shared";
import { t } from "elysia";
import { literalUnion } from "./schemas";

/**
 * A message the signed-in user posts on a review thread. Its author is not the
 * client's to say: the route stamps it from the PR's owning account
 * (`humanAuthor`).
 */
export const threadMessageBody = t.Object({
  body: t.String(),
  messageType: literalUnion(MESSAGE_TYPES),
  codeSuggestion: t.Optional(t.String()),
});
