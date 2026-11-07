import { describe, expect, it } from "bun:test";
import { githubHostLabel, normalizeGithubHost } from "./github-host";

describe("normalizeGithubHost", () => {
  it("strips protocol, whitespace and trailing slashes", () => {
    expect(normalizeGithubHost("  https://ghe.example.com/// ")).toBe("ghe.example.com");
    expect(normalizeGithubHost("HTTP://ghe.example.com")).toBe("ghe.example.com");
    expect(normalizeGithubHost("ghe.example.com")).toBe("ghe.example.com");
  });

  it("returns an empty string for blank input", () => {
    expect(normalizeGithubHost("   ")).toBe("");
  });
});

describe("githubHostLabel", () => {
  it("names github.com and passes Enterprise hosts through", () => {
    expect(githubHostLabel("github.com")).toBe("GitHub");
    expect(githubHostLabel("ghe.example.com")).toBe("ghe.example.com");
  });
});
