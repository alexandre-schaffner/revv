import { t } from "elysia";

/**
 * A message the signed-in user posts on a review thread. Its author is not the
 * client's to say: the route stamps it from the PR's owning account
 * (`humanAuthor`).
 */
export const threadMessageBody = t.Object({
  body: t.String(),
  messageType: t.Union([
    t.Literal("comment"),
    t.Literal("reply"),
    t.Literal("suggestion"),
    t.Literal("resolution"),
  ]),
  codeSuggestion: t.Optional(t.String()),
});
