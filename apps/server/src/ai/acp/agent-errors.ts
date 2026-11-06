// ── Agent failure description ────────────────────────────────────────────────
//
// An ACP adapter reports a failed turn as a JSON-RPC `-32603` whose message is
// "Internal error", optionally suffixed with the agent's own text, and whose
// `data.errorKind` names the provider failure (claude-agent-acp: `rate_limit`,
// `billing_error`, `authentication_failed`, …). When the agent's text is empty
// the message is a bare "Internal error" and `errorKind` is the only clue, so
// reading `err.message` alone turns a spent quota into an unexplained failure.
//
// This module turns that error into what the user should read, and says
// whether retrying can help. A usage or spend limit can't clear in the minutes
// an auto-continuation waits, so it is terminal: another turn would only spend
// more of a quota that's already gone.

import { type AcpAgentId, getAcpAgent } from "@revv/shared";
import { withAgentKeychainHint } from "./agent-keychain";

const INTERNAL_ERROR_PREFIX = /^Internal error:?\s*/i;

/**
 * The agent's own wording for a spent subscription quota or spend cap
 * ("You've hit your individual spend limit · … resets 7pm", "Claude AI usage
 * limit reached", "You're out of extra usage").
 */
const USAGE_LIMIT_TEXT =
  /\b(?:spend|usage|weekly|5-hour)\s+limit\b|\bout of extra usage\b|\/usage-credits\b|credit balance is too low/i;

/** Provider failure kinds that mean the account has no quota left. */
const USAGE_LIMIT_KINDS = new Set(["billing_error", "account_on_hold"]);

/** Provider failure kinds the user should read as words, not as an id. */
const KIND_LABELS: Record<string, string> = {
  authentication_failed: "authentication failed",
  oauth_org_not_allowed: "authentication failed: organization not allowed",
  billing_error: "billing error",
  account_on_hold: "account on hold",
  rate_limit: "rate limited",
  overloaded: "provider overloaded",
  server_error: "provider server error",
  invalid_request: "invalid request",
  model_not_found: "model not found",
  max_output_tokens: "output token limit reached",
};

export interface AgentFailure {
  /** What to show the user (and log). */
  readonly message: string;
  /**
   * The account is out of quota or rate-limited: retrying now, or
   * auto-continuing, can't succeed and only burns what's left.
   */
  readonly terminal: boolean;
}

/** The `data.errorKind` an ACP adapter attached to a failed request, if any. */
export function acpErrorKind(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("data" in err)) return null;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== "object" || data === null || !("errorKind" in data)) return null;
  const kind = (data as { errorKind?: unknown }).errorKind;
  return typeof kind === "string" && kind.length > 0 ? kind : null;
}

/** Describe a thrown ACP error. */
export function describeAgentError(agent: AcpAgentId, err: unknown): AgentFailure {
  const raw = err instanceof Error ? err.message : String(err);
  return describeAgentFailure(agent, raw, acpErrorKind(err));
}

/**
 * Describe an agent failure from its raw message and, when the adapter sent
 * one, its provider failure kind.
 */
export function describeAgentFailure(
  agent: AcpAgentId,
  rawMessage: string,
  errorKind: string | null = null,
): AgentFailure {
  const label = getAcpAgent(agent).label;
  const detail = rawMessage.replace(INTERNAL_ERROR_PREFIX, "").trim();

  if ((errorKind !== null && USAGE_LIMIT_KINDS.has(errorKind)) || USAGE_LIMIT_TEXT.test(detail)) {
    return {
      message: detail
        ? `${label} has reached its usage limit: ${detail}`
        : `${label} has reached its usage limit. Check your plan's usage, then retry.`,
      terminal: true,
    };
  }

  if (errorKind === "rate_limit") {
    return {
      message: detail
        ? `${label} is rate limited: ${detail}`
        : `${label} is rate limited by its provider. Wait a few minutes, then retry.`,
      terminal: true,
    };
  }

  // A bare "Internal error" names nothing; the kind is the only explanation.
  const kindLabel = errorKind ? (KIND_LABELS[errorKind] ?? errorKind.replace(/_/g, " ")) : null;
  const message = kindLabel && !detail ? `${rawMessage.trim()} (${kindLabel})` : rawMessage;
  return { message: withAgentKeychainHint(agent, message), terminal: false };
}
