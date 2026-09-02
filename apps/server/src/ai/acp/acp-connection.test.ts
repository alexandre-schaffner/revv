import { describe, expect, it } from "bun:test";
import { sanitizeMcpServerName, selectAcpAuthMethod } from "./acp-connection";

describe("selectAcpAuthMethod", () => {
  it("prefers the ChatGPT session over an API key for Codex", () => {
    expect(
      selectAcpAuthMethod("codex", [
        { id: "api-key" },
        { id: "chat-gpt" },
        { id: "chat-gpt-device-code" },
      ]),
    ).toBe("chat-gpt");
  });

  it("keeps the agent's advertised default for other providers", () => {
    expect(selectAcpAuthMethod("claude-code", [{ id: "api-key" }, { id: "oauth" }])).toBe(
      "api-key",
    );
  });
});

describe("sanitizeMcpServerName", () => {
  it("replaces the prId colon Codex chokes on", () => {
    expect(
      sanitizeMcpServerName("revv-chat-context-2eef0a52-e3d7-4c60-8d9d-48858084868c:2467"),
    ).toBe("revv-chat-context-2eef0a52-e3d7-4c60-8d9d-48858084868c-2467");
  });

  it("leaves already-safe names untouched", () => {
    expect(sanitizeMcpServerName("revv-walkthrough-0f0e41c7_7d09")).toBe(
      "revv-walkthrough-0f0e41c7_7d09",
    );
  });

  it("replaces every unsafe character, not just the first", () => {
    expect(sanitizeMcpServerName("revv chat:ctx/2467.x")).toBe("revv-chat-ctx-2467-x");
  });
});
