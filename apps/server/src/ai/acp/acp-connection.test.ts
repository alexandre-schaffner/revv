import { describe, expect, it } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  createSessionSelections,
  type SessionSelectionConnection,
  sanitizeMcpServerName,
  selectAcpAuthMethod,
} from "./acp-connection";

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

type SelectionCall =
  | {
      readonly method: "setSessionConfigOption";
      readonly configId: string;
      readonly value: unknown;
    }
  | { readonly method: "setSessionMode"; readonly modeId: string };

function recordingConnection(): {
  readonly connection: SessionSelectionConnection;
  readonly calls: SelectionCall[];
} {
  const calls: SelectionCall[] = [];
  return {
    calls,
    connection: {
      setSessionConfigOption: async (params) => {
        calls.push({
          method: "setSessionConfigOption",
          configId: params.configId,
          value: params.value,
        });
        return { configOptions: [] };
      },
      setSessionMode: async (params) => {
        calls.push({ method: "setSessionMode", modeId: params.modeId });
        return {};
      },
    },
  };
}

// opencode's `session/new` shape: no `modes`, model and agents as config options.
const OPENCODE_OPTIONS: SessionConfigOption[] = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "opencode/big-pickle",
    options: [
      { value: "opencode/big-pickle", name: "Big Pickle" },
      { value: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "build",
    options: [
      { value: "build", name: "Build" },
      { value: "plan", name: "Plan" },
    ],
  },
];

describe("createSessionSelections", () => {
  it("applies the session model and switches modes through the mode config option", async () => {
    const { connection, calls } = recordingConnection();
    const selections = createSessionSelections(connection, "anthropic/claude-sonnet-5", "opencode");
    const modes = await selections.adopt("s1", { configOptions: OPENCODE_OPTIONS });
    await selections.setMode("s1", "plan");
    expect(modes?.currentModeId).toBe("build");
    expect(calls).toEqual([
      { method: "setSessionConfigOption", configId: "model", value: "anthropic/claude-sonnet-5" },
      { method: "setSessionConfigOption", configId: "mode", value: "plan" },
    ]);
  });

  it("leaves a session on its default for a model outside the catalog", async () => {
    const { connection, calls } = recordingConnection();
    const selections = createSessionSelections(connection, "gone/model", "opencode");
    await selections.adopt("s1", { configOptions: OPENCODE_OPTIONS });
    expect(calls).toEqual([]);
  });

  it("uses session/set_mode, and no model call, for agents with dedicated modes", async () => {
    const { connection, calls } = recordingConnection();
    const selections = createSessionSelections(connection, undefined, "claude-code");
    await selections.adopt("s1", {
      modes: { currentModeId: "default", availableModes: [{ id: "plan", name: "Plan" }] },
      configOptions: OPENCODE_OPTIONS,
    });
    await selections.setMode("s1", "plan");
    expect(calls).toEqual([{ method: "setSessionMode", modeId: "plan" }]);
  });
});
