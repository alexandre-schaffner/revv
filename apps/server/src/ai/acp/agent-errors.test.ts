import { describe, expect, it } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { acpErrorKind, describeAgentError, describeAgentFailure } from "./agent-errors";

// Verbatim from a Revv server log (claude-agent-acp, Claude subscription).
const SPEND_LIMIT =
  "Internal error: You’ve hit your individual spend limit · run /usage-credits to raise it, " +
  "or visit https://claude.ai/admin-settings/usage · your 5-hour limit resets 7pm (Europe/Paris)";

describe("acpErrorKind", () => {
  it("reads the errorKind an adapter attaches to a RequestError", () => {
    expect(acpErrorKind(RequestError.internalError({ errorKind: "rate_limit" }))).toBe(
      "rate_limit",
    );
  });

  it("is null for errors without one", () => {
    expect(acpErrorKind(RequestError.internalError())).toBeNull();
    expect(acpErrorKind(RequestError.internalError({ stderr: "x" }))).toBeNull();
    expect(acpErrorKind(new Error("boom"))).toBeNull();
    expect(acpErrorKind("boom")).toBeNull();
  });
});

describe("describeAgentFailure", () => {
  it("treats a spent quota as terminal and keeps the agent's wording", () => {
    const failure = describeAgentFailure("claude-code", SPEND_LIMIT);
    expect(failure.terminal).toBe(true);
    expect(failure.message).toStartWith("Claude Code has reached its usage limit: You’ve hit");
    expect(failure.message).toContain("resets 7pm");
    expect(failure.message).not.toContain("Internal error");
  });

  it("recognises other usage-limit wordings", () => {
    for (const text of [
      "Claude AI usage limit reached|1793980800",
      "You're out of extra usage · resets 3pm",
      "Your weekly limit resets Monday",
      "Your credit balance is too low to access the Anthropic API.",
    ]) {
      expect(describeAgentFailure("claude-code", `Internal error: ${text}`).terminal).toBe(true);
    }
  });

  it("treats a billing kind behind a bare Internal error as a usage limit", () => {
    const failure = describeAgentFailure("claude-code", "Internal error", "billing_error");
    expect(failure.terminal).toBe(true);
    expect(failure.message).toBe(
      "Claude Code has reached its usage limit. Check your plan's usage, then retry.",
    );
  });

  it("treats a rate limit as terminal", () => {
    const failure = describeAgentFailure("codex", "Internal error", "rate_limit");
    expect(failure.terminal).toBe(true);
    expect(failure.message).toBe(
      "Codex is rate limited by its provider. Wait a few minutes, then retry.",
    );
  });

  it("names the kind behind a bare Internal error", () => {
    expect(describeAgentFailure("claude-code", "Internal error", "server_error")).toEqual({
      message: "Internal error (provider server error)",
      terminal: false,
    });
    expect(describeAgentFailure("claude-code", "Internal error", "some_new_kind").message).toBe(
      "Internal error (some new kind)",
    );
  });

  it("leaves other failures retryable and unchanged", () => {
    expect(describeAgentFailure("claude-code", "Internal error: boom", "server_error")).toEqual({
      message: "Internal error: boom",
      terminal: false,
    });
    expect(describeAgentFailure("claude-code", "Internal error")).toEqual({
      message: "Internal error",
      terminal: false,
    });
  });
});

describe("describeAgentError", () => {
  it("combines the message and the attached kind", () => {
    const failure = describeAgentError(
      "claude-code",
      RequestError.internalError({ errorKind: "billing_error" }),
    );
    expect(failure.terminal).toBe(true);
  });

  it("handles non-Error throws", () => {
    expect(describeAgentError("claude-code", "plain failure")).toEqual({
      message: "plain failure",
      terminal: false,
    });
  });
});
