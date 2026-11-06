import { describe, expect, it } from "bun:test";
import {
  filterRepos,
  groupByOwner,
  indexByFullName,
  isRepoSlug,
  majorityOwner,
  repoKey,
} from "./add-repo";

const repo = (owner: string, name: string) => ({ owner, name, fullName: `${owner}/${name}` });

describe("isRepoSlug", () => {
  it("accepts owner/name", () => {
    expect(isRepoSlug("acme/web.app")).toBe(true);
    expect(isRepoSlug("a-b/c_d")).toBe(true);
  });

  it("rejects anything that isn't exactly owner/name", () => {
    expect(isRepoSlug("acme")).toBe(false);
    expect(isRepoSlug("acme/web/extra")).toBe(false);
    expect(isRepoSlug("https://github.com/acme/web")).toBe(false);
    expect(isRepoSlug("acme/ web")).toBe(false);
    expect(isRepoSlug("/web")).toBe(false);
  });
});

describe("indexByFullName", () => {
  it("looks repos up case-insensitively", () => {
    const index = indexByFullName([repo("Acme", "Web")]);
    expect(index.get(repoKey("acme/web"))?.fullName).toBe("Acme/Web");
    expect(index.get(repoKey("ACME/WEB"))).toBeDefined();
    expect(index.get(repoKey("acme/api"))).toBeUndefined();
  });
});

describe("filterRepos", () => {
  const repos = [repo("acme", "web"), repo("Globex", "api"), repo("me", "dotfiles")];

  it("returns everything for a blank query", () => {
    expect(filterRepos(repos, "  ")).toEqual(repos);
  });

  it("matches owner, name or full name, ignoring case", () => {
    expect(filterRepos(repos, "GLOBEX").map((r) => r.name)).toEqual(["api"]);
    expect(filterRepos(repos, "dot").map((r) => r.name)).toEqual(["dotfiles"]);
    expect(filterRepos(repos, "acme/w").map((r) => r.name)).toEqual(["web"]);
  });
});

describe("groupByOwner", () => {
  it("merges owners that differ only in case under the first spelling", () => {
    const groups = groupByOwner([repo("Acme", "web"), repo("me", "x"), repo("acme", "api")]);
    expect([...groups.keys()]).toEqual(["Acme", "me"]);
    expect(groups.get("Acme")?.map((r) => r.name)).toEqual(["web", "api"]);
  });
});

describe("majorityOwner", () => {
  it("returns the owner of a strict majority", () => {
    expect(majorityOwner([repo("acme", "a"), repo("acme", "b"), repo("me", "c")])).toBe("acme");
  });

  it("returns null without a strict majority", () => {
    expect(majorityOwner([repo("acme", "a"), repo("me", "b")])).toBeNull();
    expect(majorityOwner([])).toBeNull();
  });
});
