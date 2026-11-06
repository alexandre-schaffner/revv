import { describe, expect, it } from "bun:test";
import { AUTO_SENTINEL, DEFAULT_USER_SETTINGS, type UserSettings } from "@revv/shared";
import { agentLaunchFor, resolveGenerationModel } from "./agent-launch";

const settings = (patch: Partial<UserSettings>): UserSettings => ({
  ...DEFAULT_USER_SETTINGS,
  ...patch,
});

describe("resolveGenerationModel", () => {
  it("keeps a model valid for the agent", () => {
    expect(resolveGenerationModel("claude-code", "claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(resolveGenerationModel("codex", "gpt-6-sol")).toBe("gpt-6-sol");
    expect(resolveGenerationModel("codex", "gpt-6.1-sol")).toBe("gpt-6.1-sol");
  });

  it("falls back to the agent default when the model belongs to another agent", () => {
    expect(resolveGenerationModel("claude-code", "sonnet-4.6")).toBe("claude-sonnet-5-5");
  });

  it("trusts opencode's dynamic catalog", () => {
    expect(resolveGenerationModel("opencode", "some-provider/some-model")).toBe(
      "some-provider/some-model",
    );
    expect(resolveGenerationModel("opencode", null)).toBe("opencode/big-pickle");
  });

  it("drops another agent's static model id for opencode", () => {
    expect(resolveGenerationModel("opencode", "claude-sonnet-5-5")).toBe("opencode/big-pickle");
  });

  it("collapses Auto before static and dynamic catalog resolution", () => {
    expect(resolveGenerationModel("claude-code", AUTO_SENTINEL)).toBe("claude-sonnet-5-5");
    expect(resolveGenerationModel("opencode", AUTO_SENTINEL)).toBe("opencode/big-pickle");
    expect(resolveGenerationModel("claude-code", AUTO_SENTINEL, "claude-opus-5-5")).toBe(
      "claude-opus-5-5",
    );
  });
});

describe("agentLaunchFor", () => {
  const configured = settings({ aiModel: "claude-opus-5-5", aiThinkingEffort: "high" });

  it("runs chat, briefs and recaps on the configured model and effort", () => {
    for (const purpose of ["chat", "brief", "recap"] as const) {
      expect(agentLaunchFor(configured, "claude-code", purpose)).toEqual({
        agent: "claude-code",
        model: "claude-opus-5-5",
        thinkingEffort: "high",
      });
    }
  });

  it("applies a review's sized override, and Auto effort only when sized", () => {
    expect(
      agentLaunchFor(
        settings({ aiModel: AUTO_SENTINEL, aiThinkingEffort: AUTO_SENTINEL }),
        "claude-code",
        "review",
        {
          model: "claude-haiku-5-5",
          thinkingEffort: "low",
        },
      ),
    ).toEqual({ agent: "claude-code", model: "claude-haiku-5-5", thinkingEffort: "low" });
    expect(
      agentLaunchFor(settings({ aiThinkingEffort: AUTO_SENTINEL }), "claude-code", "chat")
        .thinkingEffort,
    ).toBeUndefined();
  });

  it("routes the suggestions model through the agent's catalog, falling back to its cheap model", () => {
    expect(
      agentLaunchFor(
        settings({ aiSuggestionsModel: "claude-haiku-5-5" }),
        "claude-code",
        "suggestions",
      )?.model,
    ).toBe("claude-haiku-5-5");
    expect(
      agentLaunchFor(settings({ aiSuggestionsModel: "gpt-6-luna" }), "claude-code", "suggestions")
        ?.model,
    ).toBe("claude-haiku-4-5-20251001");
    expect(
      agentLaunchFor(settings({ aiSuggestionsModel: "" }), "claude-code", "suggestions"),
    ).toBeNull();
  });

  it("tests an agent on the review model at low effort", () => {
    expect(agentLaunchFor(configured, "codex", "check")).toEqual({
      agent: "codex",
      model: "gpt-6.1-sol",
      thinkingEffort: "low",
    });
  });
});
