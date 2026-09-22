import { describe, expect, it } from "bun:test";
import { ACP_AGENT_IDS, AUTO_MODEL_SENTINEL, getAgentCapabilities } from "@revv/shared";
import {
  DEPTH_CONFIDENCE_FLOOR,
  DEPTH_MARGIN_FLOOR,
  REASONING_EFFORTS,
  type RouteDepthInput,
  routeDepth,
} from "./routing";

/** A confident, unambiguous answer — the baseline every case varies from. */
function input(over: Partial<RouteDepthInput> = {}): RouteDepthInput {
  return {
    agent: "claude-code",
    depth: "deep",
    confidence: 0.9,
    probabilities: { shallow: 0.02, standard: 0.08, deep: 0.9 },
    configuredModel: "claude-sonnet-5",
    reasoningEffort: "thorough",
    ...over,
  };
}

describe("routeDepth", () => {
  it("upgrades a pinned model when the answer is confident", () => {
    expect(routeDepth(input())?.model).toBe("claude-opus-5");
  });

  it("never downgrades a pinned model", () => {
    // Sonnet is pinned and the answer says shallow. The cost is asymmetric —
    // an under-powered model on a PR the user cares about is worse than a
    // few wasted cents — so the pin wins.
    expect(routeDepth(input({ depth: "shallow" }))).toBeNull();
    expect(routeDepth(input({ depth: "standard" }))).toBeNull();
  });

  it("downgrades only when the user declined to pin a model", () => {
    const routed = routeDepth(input({ depth: "shallow", configuredModel: AUTO_MODEL_SENTINEL }));
    expect(routed?.model).toBe("claude-haiku-4-5-20251001");
  });

  it("leaves an off-ladder pinned model alone", () => {
    // No way to tell whether the routed tier is an upgrade or a downgrade
    // from a model that isn't on the ladder at all.
    expect(routeDepth(input({ configuredModel: "claude-fable-5" }))).toBeNull();
    expect(routeDepth(input({ configuredModel: null }))).toBeNull();
  });

  it("declines below the confidence floor", () => {
    expect(routeDepth(input({ confidence: DEPTH_CONFIDENCE_FLOOR - 0.01 }))).toBeNull();
    expect(routeDepth(input({ confidence: DEPTH_CONFIDENCE_FLOOR }))?.model).toBe("claude-opus-5");
  });

  it("declines when the runner-up is within the margin", () => {
    const tie = 0.5 - DEPTH_MARGIN_FLOOR / 4;
    expect(
      routeDepth(input({ probabilities: { shallow: 0.0, standard: tie, deep: 1 - tie } })),
    ).toBeNull();
  });

  it("returns null for every agent without a depth ladder", () => {
    for (const agent of ACP_AGENT_IDS) {
      if (agent === "claude-code") continue;
      expect(routeDepth(input({ agent, configuredModel: AUTO_MODEL_SENTINEL }))).toBeNull();
    }
  });

  it("never emits a model outside the agent's catalog", () => {
    for (const depth of ["shallow", "standard", "deep"] as const) {
      const routed = routeDepth(input({ depth, configuredModel: AUTO_MODEL_SENTINEL }));
      if (!routed) continue;
      const caps = getAgentCapabilities("claude-code");
      expect(caps.models).not.toBe("dynamic");
      if (caps.models === "dynamic") continue;
      expect(caps.models.map((m) => m.value)).toContain(routed.model);
    }
  });

  it("carries the answered reasoning effort, not one derived from depth", () => {
    // Depth and effort are separate questions: a change can be shallow to
    // follow yet expensive to get wrong.
    expect(routeDepth(input({ reasoningEffort: "minimal" }))?.thinkingEffort).toBe("low");
    expect(routeDepth(input({ reasoningEffort: "exhaustive" }))?.thinkingEffort).toBe("max");
  });

  it("clamps the effort to a tier the agent actually accepts", () => {
    for (const effort of REASONING_EFFORTS) {
      const routed = routeDepth(input({ reasoningEffort: effort }));
      const allowed = getAgentCapabilities("claude-code").thinkingEfforts;
      expect(routed?.thinkingEffort).toBeDefined();
      if (routed?.thinkingEffort) expect(allowed).toContain(routed.thinkingEffort);
    }
  });
});
