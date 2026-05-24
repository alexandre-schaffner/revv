import { t } from "elysia";

// Shared Elysia body/query schemas reused across routes. Keeping these
// colocated avoids near-duplicate `t.Union([t.Literal("stable"), ...])`
// expressions drifting apart over time.

const channelLiteral = t.Union([t.Literal("stable"), t.Literal("nightly")]);

export const updateChannelSchema = {
  /** Optional inside a `PATCH /api/settings` body. */
  optional: channelLiteral,
  /** Required inside `PUT /api/update-channel` body. */
  put: t.Object({ channel: channelLiteral }),
};
