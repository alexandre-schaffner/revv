import { describe, expect, test } from "bun:test";
import type { AppInstallation } from "./GitHub";
import { explainRepoNotFound } from "./repo-access";

const HOST = "acme.ghe.com";

function installation(overrides: Partial<AppInstallation>): AppInstallation {
  return {
    accountLogin: "Acme",
    repositorySelection: "selected",
    htmlUrl: "https://acme.ghe.com/organizations/Acme/settings/installations/7",
    appSlug: "revv-acme",
    ...overrides,
  };
}

describe("explainRepoNotFound", () => {
  test("an OAuth App token gets the plain not-found explanation", () => {
    const err = explainRepoNotFound("Acme/api", HOST, null);
    expect(err.message).toBe("Acme/api wasn't found on acme.ghe.com");
    expect(err.action).toBeNull();
  });

  test("an installation limited to selected repos links to its settings", () => {
    const err = explainRepoNotFound("acme/api", HOST, [installation({})]);
    expect(err.message).toBe("Revv can't see acme/api yet");
    expect(err.action).toEqual({
      label: "Grant access",
      url: "https://acme.ghe.com/organizations/Acme/settings/installations/7",
    });
  });

  test("an installation on all repos means the repo really isn't reachable", () => {
    const err = explainRepoNotFound("Acme/api", HOST, [
      installation({ repositorySelection: "all" }),
    ]);
    expect(err.message).toBe("Acme/api wasn't found on acme.ghe.com");
    expect(err.action).toBeNull();
  });

  test("an owner without an installation links to the install page", () => {
    const err = explainRepoNotFound("Other/api", HOST, [installation({})]);
    expect(err.message).toBe("The GitHub App isn't installed on Other");
    expect(err.action).toEqual({
      label: "Install app",
      url: "https://acme.ghe.com/apps/revv-acme/installations/new",
    });
  });

  test("with no installation at all the app slug is unknown, so there's no link", () => {
    const err = explainRepoNotFound("Other/api", HOST, []);
    expect(err.message).toBe("The GitHub App isn't installed on Other");
    expect(err.action).toBeNull();
  });
});
