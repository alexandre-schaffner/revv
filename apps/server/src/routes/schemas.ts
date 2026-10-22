import { t } from "elysia";

// Shared Elysia body/query schemas reused across routes. Keeping these
// colocated avoids near-duplicate `t.Union([t.Literal("stable"), ...])`
// expressions drifting apart over time.

const channelLiteral = t.Union([t.Literal("stable"), t.Literal("nightly")]);

/** `baseConflictStrategy` inside a `PATCH /api/settings` body. */
export const baseConflictStrategySchema = t.Union([t.Literal("merge"), t.Literal("rebase")]);

export const updateChannelSchema = {
  /** Optional inside a `PATCH /api/settings` body. */
  optional: channelLiteral,
  /** Required inside `PUT /api/update-channel` body. */
  put: t.Object({ channel: channelLiteral }),
};
