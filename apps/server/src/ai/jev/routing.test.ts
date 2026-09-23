import { describe, expect, it } from "bun:test";
import { ACP_AGENT_IDS, AUTO_SENTINEL, getAgentCapabilities } from "@revv/shared";
import {
  DEPTH_CONFIDENCE_FLOOR,
  DEPTH_MARGIN_FLOOR,
  REASONING_EFFORTS,
  type RouteSizingInput,
  routeSizing,
} from "./routing";

/** A confident, unambiguous answer — the baseline every case varies from. */
function input(over: Partial<RouteSizingInput> = {}): RouteSizingInput {
  return {
    agent: "claude-code",
    depth: "deep",
    confidence: 0.9,
    probabilities: { shallow: 0.02, standard: 0.08, deep: 0.9 },
    configuredModel: "claude-sonnet-5",
    configuredEffort: AUTO_SENTINEL,
    reasoningEffort: "thorough",
    ...over,
  };
}

describe("routeSizing — model", () => {
  it("upgrades a pinned model when the answer is confident", () => {
    expect(routeSizing(input())?.model).toBe("claude-opus-5");
  });

  it("never downgrades a pinned model", () => {
    // Asymmetric cost: an under-powered model is worse than wasted cents, so the pin wins.
    expect(routeSizing(input({ depth: "shallow" }))?.model).toBeUndefined();
    expect(routeSizing(input({ depth: "standard" }))?.model).toBeUndefined();
  });

  it("downgrades only when the user declined to pin a model", () => {
    const routed = routeSizing(input({ depth: "shallow", configuredModel: AUTO_SENTINEL }));
    expect(routed?.model).toBe("claude-haiku-4-5-20251001");
  });

  it("leaves an off-ladder pinned model alone", () => {
    // No way to tell if the routed tier is an upgrade or downgrade from an off-ladder model.
    expect(routeSizing(input({ configuredModel: "claude-fable-5" }))?.model).toBeUndefined();
    expect(routeSizing(input({ configuredModel: null }))?.model).toBeUndefined();
  });

  it("declines below the confidence floor", () => {
    expect(
      routeSizing(input({ confidence: DEPTH_CONFIDENCE_FLOOR - 0.01 }))?.model,
    ).toBeUndefined();
    expect(routeSizing(input({ confidence: DEPTH_CONFIDENCE_FLOOR }))?.model).toBe("claude-opus-5");
  });

  it("declines when the runner-up is within the margin", () => {
    const tie = 0.5 - DEPTH_MARGIN_FLOOR / 4;
    expect(
      routeSizing(input({ probabilities: { shallow: 0.0, standard: tie, deep: 1 - tie } }))?.model,
    ).toBeUndefined();
  });

  it("emits no model for an agent without a depth ladder", () => {
    for (const agent of ACP_AGENT_IDS) {
      if (agent === "claude-code") continue;
      expect(routeSizing(input({ agent, configuredModel: AUTO_SENTINEL }))?.model).toBeUndefined();
    }
  });

  it("never emits a model outside the agent's catalog", () => {
    for (const depth of ["shallow", "standard", "deep"] as const) {
      const routed = routeSizing(input({ depth, configuredModel: AUTO_SENTINEL }));
      if (!routed?.model) continue;
      const caps = getAgentCapabilities("claude-code");
      expect(caps.models).not.toBe("dynamic");
      if (caps.models === "dynamic") continue;
      expect(caps.models.map((m) => m.value)).toContain(routed.model);
    }
  });
});

describe("routeSizing — effort", () => {
  it("carries the answered reasoning effort, not one derived from depth", () => {
    // A change can be shallow to follow yet expensive to get wrong.
    expect(routeSizing(input({ reasoningEffort: "minimal" }))?.thinkingEffort).toBe("low");
    expect(routeSizing(input({ reasoningEffort: "exhaustive" }))?.thinkingEffort).toBe("max");
  });

  it("clamps the effort to a tier the agent actually accepts", () => {
    for (const effort of REASONING_EFFORTS) {
      const routed = routeSizing(input({ reasoningEffort: effort }));
      const allowed = getAgentCapabilities("claude-code").thinkingEfforts;
      expect(routed?.thinkingEffort).toBeDefined();
      if (routed?.thinkingEffort) expect(allowed).toContain(routed.thinkingEffort);
    }
  });

  it("leaves a pinned effort alone", () => {
    expect(routeSizing(input({ configuredEffort: "low" }))?.thinkingEffort).toBeUndefined();
    expect(routeSizing(input({ configuredEffort: null }))?.thinkingEffort).toBeUndefined();
  });

  it("still sizes the effort when the model half declines", () => {
    // Pinned model at the routed tier — nothing to upgrade.
    const routed = routeSizing(input({ depth: "shallow", reasoningEffort: "exhaustive" }));
    expect(routed?.model).toBeUndefined();
    expect(routed?.thinkingEffort).toBe("max");
  });

  it("sizes the effort for agents that have no depth ladder at all", () => {
    for (const agent of ACP_AGENT_IDS) {
      if (agent === "claude-code") continue;
      if (getAgentCapabilities(agent).thinkingEfforts.length === 0) continue;
      const routed = routeSizing(input({ agent, reasoningEffort: "exhaustive" }));
      expect(routed?.model).toBeUndefined();
      expect(routed?.thinkingEffort).toBeDefined();
    }
  });

  it("returns null only when neither half applies", () => {
    expect(routeSizing(input({ depth: "shallow", configuredEffort: "high" }))).toBeNull();
  });
});
