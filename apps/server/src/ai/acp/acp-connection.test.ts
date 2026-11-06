import { describe, expect, it } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  acpErrorMessage,
  agentStartupFailureMessage,
  createSessionSelections,
  type SessionSelectionConnection,
  sanitizeMcpServerName,
} from "./acp-connection";
import { looksLikeAuthFailure } from "./agent-failure";

describe("acpErrorMessage", () => {
  it("names the cause the SDK tucks into data.details", () => {
    expect(acpErrorMessage("Internal error", { details: "Model overloaded" })).toBe(
      "Internal error: Model overloaded",
    );
  });

  it("keeps a message that already carries the detail", () => {
    expect(
      acpErrorMessage("Internal error: You've hit your limit", {
        details: "You've hit your limit",
      }),
    ).toBe("Internal error: You've hit your limit");
  });

  it("leaves other structured data, such as an adapter's errorKind, to the caller", () => {
    expect(acpErrorMessage("Internal error", { errorKind: "billing_error" })).toBe(
      "Internal error",
    );
  });

  it("leaves the message alone when data is absent or empty", () => {
    expect(acpErrorMessage("Internal error", undefined)).toBe("Internal error");
    expect(acpErrorMessage("Internal error", {})).toBe("Internal error");
    expect(acpErrorMessage("Internal error", { details: "  " })).toBe("Internal error");
  });

  it("clips a long detail", () => {
    const message = acpErrorMessage("Internal error", { details: "x".repeat(2000) });
    expect(message.length).toBeLessThan(600);
    expect(message.endsWith("…")).toBe(true);
  });
});

describe("agentStartupFailureMessage", () => {
  // npx run inside a Bun monorepo that npm can't parse dies before the
  // adapter starts. That used to surface as "ACP connection closed" plus
  // Keychain advice, which sent every user to the wrong fix.
  const npmFailure = [
    "npm error code EUNSUPPORTEDPROTOCOL",
    'npm error Unsupported URL Type "catalog:": catalog:v4',
    "npm error A complete log of this run can be found in: /tmp/npm.log",
    "",
  ].join("\n");

  it("names the exit code and keeps what the process printed", () => {
    expect(agentStartupFailureMessage("claude-code", 1, npmFailure)).toBe(
      [
        "The Claude Code agent exited before it started (exit code 1).",
        "",
        "npm error code EUNSUPPORTEDPROTOCOL",
        'npm error Unsupported URL Type "catalog:": catalog:v4',
        "npm error A complete log of this run can be found in: /tmp/npm.log",
      ].join("\n"),
    );
  });

  it("is not read as an auth failure", () => {
    expect(looksLikeAuthFailure(agentStartupFailureMessage("claude-code", 1, npmFailure))).toBe(
      false,
    );
  });

  it("keeps only the last lines of a long stderr", () => {
    const stderr = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const message = agentStartupFailureMessage("codex", 7, stderr);

    expect(message).not.toContain("line 13");
    expect(message.endsWith("line 14\nline 15\nline 16\nline 17\nline 18\nline 19")).toBe(true);
  });

  it("stands alone when the process printed nothing", () => {
    expect(agentStartupFailureMessage("codex", 1, "  \n")).toBe(
      "The Codex agent exited before it started (exit code 1).",
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
    const { modes, unavailableModel } = await selections.adopt("s1", {
      configOptions: OPENCODE_OPTIONS,
    });
    await selections.setMode("s1", "plan");
    expect(modes?.currentModeId).toBe("build");
    expect(unavailableModel).toBeUndefined();
    expect(calls).toEqual([
      { method: "setSessionConfigOption", configId: "model", value: "anthropic/claude-sonnet-5" },
      { method: "setSessionConfigOption", configId: "mode", value: "plan" },
    ]);
  });

  it("reports a model outside the catalog and leaves the session on its default", async () => {
    const { connection, calls } = recordingConnection();
    const selections = createSessionSelections(connection, "gone/model", "opencode");
    const { unavailableModel } = await selections.adopt("s1", { configOptions: OPENCODE_OPTIONS });
    expect(unavailableModel).toBe("gone/model");
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

  const CLAUDE_MODES = [
    { id: "default", name: "Default" },
    { id: "acceptEdits", name: "Accept Edits" },
    { id: "plan", name: "Plan" },
    { id: "auto", name: "Auto" },
  ];

  it("moves a Claude session out of Auto mode into Revv's session mode", async () => {
    const { connection, calls } = recordingConnection();
    const selections = createSessionSelections(connection, undefined, "claude-code");
    const { modes } = await selections.adopt("s1", {
      modes: { currentModeId: "auto", availableModes: CLAUDE_MODES },
    });
    expect(calls).toEqual([{ method: "setSessionMode", modeId: "default" }]);
    expect(modes?.currentModeId).toBe("default");
  });

  it("leaves a Claude session already in Revv's session mode alone", async () => {
    const { connection, calls } = recordingConnection();
    const selections = createSessionSelections(connection, undefined, "claude-code");
    await selections.adopt("s1", {
      modes: { currentModeId: "default", availableModes: CLAUDE_MODES },
    });
    expect(calls).toEqual([]);
  });

  it("keeps the starting mode of an agent with no session mode", async () => {
    const { connection, calls } = recordingConnection();
    const selections = createSessionSelections(connection, undefined, "codex");
    const { modes } = await selections.adopt("s1", {
      modes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "Auto" }] },
    });
    expect(calls).toEqual([]);
    expect(modes?.currentModeId).toBe("auto");
  });
});
