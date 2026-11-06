import { describe, expect, it } from "bun:test";
import { serverEnv } from "../config";
import { hostFromProviderId, LEGACY_GITHUB_PROVIDER_ID, providerIdForHost } from "./provider-id";

describe("providerId codec", () => {
  it("round-trips a host", () => {
    for (const host of ["github.com", "ghe.example.com"]) {
      expect(hostFromProviderId(providerIdForHost(host))).toBe(host);
    }
  });

  it("reads the legacy bare id as the configured host", () => {
    expect(hostFromProviderId(LEGACY_GITHUB_PROVIDER_ID)).toBe(serverEnv.githubHost);
  });
});
