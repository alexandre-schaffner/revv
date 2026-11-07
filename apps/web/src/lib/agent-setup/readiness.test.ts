import { describe, expect, it } from "bun:test";
import type { AgentStatus } from "@revv/shared";
import { agentReadiness } from "./readiness";

const status = (patch: Partial<AgentStatus>): AgentStatus => ({
  installed: true,
  authed: true,
  verified: true,
  authSource: "subscription",
  authLabel: "Signed in",
  authWarning: null,
  loginCommand: null,
  ...patch,
});

describe("agentReadiness", () => {
  it("walks unchecked → install → sign-in → ready", () => {
    expect(agentReadiness(null)).toMatchObject({ ready: false, needs: null, label: "Not checked" });
    expect(agentReadiness(status({ installed: false }))).toMatchObject({
      ready: false,
      needs: "install",
    });
    expect(agentReadiness(status({ authed: false }))).toMatchObject({
      ready: false,
      needs: "sign-in",
      tone: "warning",
    });
    expect(agentReadiness(status({}))).toMatchObject({ ready: true, tone: "success" });
  });

  it("calls an unverified login configured, not connected", () => {
    expect(agentReadiness(status({ verified: false }))).toMatchObject({
      ready: true,
      tone: "warning",
      label: "Configured",
    });
  });
});
