import { describe, expect, test } from "bun:test";
import { codeownersFor, codeownersPatternRegex, parseCodeowners } from "@revv/shared";

describe("parseCodeowners", () => {
  test("reads rules, skipping comments, blanks, and negations", () => {
    const rules = parseCodeowners(
      [
        "# Owners",
        "",
        "*       @org/core   # everyone",
        "/docs/  docs@example.com",
        "!skip @x",
        "/apps/api",
      ].join("\n"),
    );
    expect(rules).toEqual([
      { line: 3, pattern: "*", owners: ["@org/core"] },
      { line: 4, pattern: "/docs/", owners: ["docs@example.com"] },
      { line: 6, pattern: "/apps/api", owners: [] },
    ]);
  });
});

describe("codeownersPatternRegex", () => {
  const cases: Array<[string, string, boolean]> = [
    ["*", "a/b/c.ts", true],
    ["*.js", "src/deep/x.js", true],
    ["*.js", "src/x.ts", false],
    ["/build/logs/", "build/logs/a/b.txt", true],
    ["/build/logs/", "x/build/logs/a.txt", false],
    ["docs/*", "docs/getting-started.md", true],
    ["docs/*", "docs/build-app/troubleshooting.md", false],
    ["apps/", "packages/apps/x.ts", true],
    ["**/logs", "deep/a/logs/x.log", true],
    ["/scripts/**", "scripts/a/b.sh", true],
    ["apps/*/src", "apps/web/src/main.ts", true],
    ["apps/web", "apps/web/src/main.ts", true],
    ["apps/web", "apps/webkit/x.ts", false],
    ["file?.txt", "file1.txt", true],
  ];
  for (const [pattern, path, expected] of cases) {
    test(`${pattern} ${expected ? "matches" : "skips"} ${path}`, () => {
      expect(codeownersPatternRegex(pattern).test(path)).toBe(expected);
    });
  }
});

describe("codeownersFor", () => {
  test("the last matching rule wins, and an owner-less rule unowns", () => {
    const rules = parseCodeowners(
      ["*  @org/core", "/apps/api/  @org/api @alice", "/apps/api/generated/"].join("\n"),
    );
    const owners = codeownersFor(rules, [
      "README.md",
      "apps/api/src/index.ts",
      "apps/api/generated/client.ts",
    ]);
    expect(owners.get("README.md")).toEqual(["@org/core"]);
    expect(owners.get("apps/api/src/index.ts")).toEqual(["@org/api", "@alice"]);
    expect(owners.get("apps/api/generated/client.ts")).toEqual([]);
  });
});
