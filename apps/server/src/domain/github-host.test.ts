import { describe, expect, it } from "bun:test";
import { githubHostLabel, isPublicGitHub, normalizeGithubHost, sameGithubHost } from "@revv/shared";
import { serverEnv } from "../config";
import { hostFromProviderId, LEGACY_GITHUB_PROVIDER_ID, providerIdForHost } from "./github-host";

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

describe("shared host rules", () => {
  it("normalizes a typed host to its stored form", () => {
    expect(normalizeGithubHost("  https://ghe.example.com/// ")).toBe("ghe.example.com");
    expect(normalizeGithubHost("HTTP://GHE.Example.com")).toBe("ghe.example.com");
    expect(normalizeGithubHost("   ")).toBe("");
  });

  it("compares hosts case-insensitively", () => {
    expect(isPublicGitHub("GitHub.com")).toBe(true);
    expect(isPublicGitHub("ghe.example.com")).toBe(false);
    expect(sameGithubHost("GHE.example.com ", "ghe.example.com")).toBe(true);
  });

  it("names github.com and passes Enterprise hosts through", () => {
    expect(githubHostLabel("github.com")).toBe("GitHub");
    expect(githubHostLabel("ghe.example.com")).toBe("ghe.example.com");
  });
});
