import { describe, expect, it } from "bun:test";
import { fillTemplate } from "./fill-template";

describe("fillTemplate", () => {
  it("inserts values verbatim, substitution patterns and markers included", () => {
    expect(
      fillTemplate("on {{BRANCH}} from {{SOURCE}}", {
        BRANCH: "fix/$&-$'",
        SOURCE: "{{BRANCH}}",
      }),
    ).toBe("on fix/$&-$' from {{BRANCH}}");
  });

  it("fills every occurrence and leaves unknown markers", () => {
    expect(fillTemplate("{{A}} {{A}} {{B}}", { A: "a" })).toBe("a a {{B}}");
  });
});
