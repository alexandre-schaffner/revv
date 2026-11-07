import { t } from "elysia";

/**
 * A message the signed-in user posts on a review thread. Its author and its
 * type are not the client's to say: the route stamps the author from the PR's
 * owning account (`humanAuthor`), and knows whether it starts a thread or
 * replies to one.
 */
export const threadMessageBody = t.Object({ body: t.String() });
