import { describe, expect, it } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  findPlanModeId,
  modeToExitPlan,
  planModelSelection,
  resolveSessionModes,
} from "./session-config";

// Shapes as `opencode acp` 2.0.15 returns them from `session/new`: no `modes`,
// the agents and the catalog as `mode` / `model` select options.
const OPENCODE_CONFIG_OPTIONS: SessionConfigOption[] = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "opencode/mimo-v2.6-flash-free",
    options: [
      { value: "opencode/big-pickle", name: "opencode/Big Pickle" },
      { value: "opencode/mimo-v2.6-flash-free", name: "opencode/MiMo-V2.6-Flash Free" },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "build",
    options: [
      { value: "build", name: "Build", description: "The default agent." },
      { value: "plan", name: "Plan", description: "Read-only agent for planning work." },
    ],
  },
];

describe("resolveSessionModes", () => {
  it("prefers the dedicated modes field", () => {
    const modes = {
      currentModeId: "default",
      availableModes: [{ id: "default", name: "Default" }],
    };
    expect(resolveSessionModes({ modes, configOptions: OPENCODE_CONFIG_OPTIONS })).toEqual({
      modes,
    });
  });

  it("reads opencode 2's mode config option", () => {
    const resolved = resolveSessionModes({ configOptions: OPENCODE_CONFIG_OPTIONS });
    expect(resolved.modeConfigId).toBe("mode");
    expect(resolved.modes?.currentModeId).toBe("build");
    expect(resolved.modes?.availableModes.map((m) => m.id)).toEqual(["build", "plan"]);
    expect(findPlanModeId(resolved.modes)).toBe("plan");
  });

  it("flattens grouped options", () => {
    const resolved = resolveSessionModes({
      configOptions: [
        {
          id: "agent",
          name: "Agent",
          category: "mode",
          type: "select",
          currentValue: "a",
          options: [{ group: "g", name: "G", options: [{ value: "a", name: "A" }] }],
        },
      ],
    });
    expect(resolved.modes?.availableModes).toEqual([{ id: "a", name: "A" }]);
  });

  it("reports no modes when neither shape is present", () => {
    expect(resolveSessionModes({})).toEqual({ modes: null });
  });
});

// Claude Code's ACP adapter (claude-agent-acp 0.82): `default` is described as
// "Always ask before making changes" and must not be taken for the plan mode.
const CLAUDE_MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Manual", description: "Always ask before making changes" },
    { id: "acceptEdits", name: "Accept edits", description: "Automatically accept all file edits" },
    { id: "plan", name: "Plan", description: "Create a plan before making changes" },
    { id: "dontAsk", name: "Don't ask", description: "Skip permission prompts" },
  ],
};

describe("findPlanModeId", () => {
  it("ignores descriptions and picks Claude Code's plan mode", () => {
    expect(findPlanModeId(CLAUDE_MODES)).toBe("plan");
  });

  it("does not read dontAsk as an ask mode", () => {
    expect(
      findPlanModeId({
        currentModeId: "default",
        availableModes: [
          { id: "dontAsk", name: "Don't ask" },
          { id: "ask", name: "Ask" },
        ],
      }),
    ).toBe("ask");
  });

  it("falls back to a mode whose id mentions read-only", () => {
    expect(
      findPlanModeId({
        currentModeId: "auto",
        availableModes: [
          { id: "auto", name: "Default" },
          { id: "read-only", name: "Read Only" },
        ],
      }),
    ).toBe("read-only");
  });
});

describe("modeToExitPlan", () => {
  it("returns the first non-plan mode while the session sits in plan", () => {
    const { modes } = resolveSessionModes({
      configOptions: OPENCODE_CONFIG_OPTIONS.map((o) =>
        o.id === "mode" && o.type === "select" ? { ...o, currentValue: "plan" } : o,
      ),
    });
    expect(modeToExitPlan(modes)).toBe("build");
  });

  it("leaves a session outside plan mode alone", () => {
    expect(modeToExitPlan(CLAUDE_MODES)).toBe(undefined);
    expect(
      modeToExitPlan(resolveSessionModes({ configOptions: OPENCODE_CONFIG_OPTIONS }).modes),
    ).toBe(undefined);
    expect(modeToExitPlan(null)).toBe(undefined);
  });
});

describe("planModelSelection", () => {
  it("switches to a model in the catalog", () => {
    expect(planModelSelection(OPENCODE_CONFIG_OPTIONS, "opencode/big-pickle")).toEqual({
      kind: "switch",
      configId: "model",
    });
  });

  it("skips the model the session already uses", () => {
    expect(planModelSelection(OPENCODE_CONFIG_OPTIONS, "opencode/mimo-v2.6-flash-free")).toEqual({
      kind: "current",
    });
  });

  it("flags a model the catalog lacks", () => {
    expect(planModelSelection(OPENCODE_CONFIG_OPTIONS, "ollama/llama")).toEqual({
      kind: "unavailable",
      configId: "model",
    });
  });

  it("reports an agent with no model option", () => {
    expect(planModelSelection(null, "opencode/big-pickle")).toEqual({ kind: "none" });
  });
});
