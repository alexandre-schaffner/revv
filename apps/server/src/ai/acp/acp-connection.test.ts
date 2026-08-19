import { describe, expect, it } from "bun:test";
import { selectAcpAuthMethod } from "./acp-connection";

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
