import { t } from "elysia";

/** A message posted on a review thread, as the web sends it. */
export const threadMessageBody = t.Object({
  authorRole: t.Union([t.Literal("reviewer"), t.Literal("coder"), t.Literal("ai_agent")]),
  authorName: t.String(),
  authorLogin: t.Optional(t.String()),
  body: t.String(),
  messageType: t.Union([
    t.Literal("comment"),
    t.Literal("reply"),
    t.Literal("suggestion"),
    t.Literal("resolution"),
  ]),
  codeSuggestion: t.Optional(t.String()),
});
